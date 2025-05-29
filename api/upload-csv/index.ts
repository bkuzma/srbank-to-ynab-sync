import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parse } from 'csv-parse/sync';
import { formatInTimeZone } from 'date-fns-tz';
import * as ynab from 'ynab';
import faunadb from 'faunadb';
import { IncomingForm, Fields, Files, File } from 'formidable';
import fs from 'fs';
import { basicAuth } from '../middleware';

require('dotenv').config();

// Extend VercelRequest to include formidable file (not needed, handled in handler)

// Runtime check for required env variables
const requiredEnv = [
    'FAUNA_KEY',
    'FAUNA_BASE_URL',
    'FAUNA_COLLECTION_NAME',
    'FAUNA_DOCUMENT_ID',
    'YNAB_TOKEN',
    'YNAB_BUDGET_ID',
    'YNAB_CREDIT_CARD_ACCOUNT_ID',
];
for (const key of requiredEnv) {
    if (!process.env[key]) throw new Error(`Missing env variable: ${key}`);
}

const q = faunadb.query;
const client = new faunadb.Client({
    secret: process.env.FAUNA_KEY!,
    endpoint: process.env.FAUNA_BASE_URL!,
});

enum KV_KEY {
    LAST_SYNC_DATE = 'lastSyncDate',
}

interface FaunaResponse {
    data: {
        [key: string]: string;
    };
}

const getValueFromBucket = async (key: string): Promise<string> => {
    const value = (await client.query(
        q.Get(
            q.Ref(
                q.Collection(process.env.FAUNA_COLLECTION_NAME!),
                process.env.FAUNA_DOCUMENT_ID!
            )
        )
    )) as FaunaResponse;
    return value.data[key];
};

const getDateString = (date: Date): string => {
    return formatInTimeZone(date, 'Europe/Oslo', 'yyyy-MM-dd');
};

interface CsvTransaction {
    Kjøpsdato: string;
    Posteringsdato: string;
    Beskrivelse: string;
    Beløp: string;
}

function cleanDate(dateStr: string | undefined | null): string {
    if (!dateStr) return '';
    return dateStr.replace(/^"+|"+$/g, '').trim();
}

function getPosteringsdato(transaction: any): string | undefined {
    return transaction.Posteringsdato || transaction.posteringsdato;
}

const mapCsvTransactionsToYnabTransactions = (
    csvTransactions: CsvTransaction[],
    lastSyncDate: string
): ynab.SaveTransaction[] => {
    const occurenceMap: { [key: string]: number } = {};
    const filtered = csvTransactions.filter((transaction, idx) => {
        const posteringsdato = getPosteringsdato(transaction);
        if (!posteringsdato) return false;
        const cleaned = cleanDate(posteringsdato);
        const transactionDate = getDateString(new Date(cleaned));
        const shouldInclude = transactionDate > lastSyncDate;
        return shouldInclude;
    });
    return filtered.map((transaction) => {
        const posteringsdato = getPosteringsdato(transaction);
        const transactionKey = `${posteringsdato}${transaction.Beløp}`;
        if (!occurenceMap[transactionKey]) {
            occurenceMap[transactionKey] = 1;
        } else {
            occurenceMap[transactionKey] += 1;
        }
        const occurrence = occurenceMap[transactionKey];
        const date = cleanDate(posteringsdato);
        // Convert amount to milliunits (multiply by 1000)
        // Replace comma with dot and convert to number
        const amount = Number(
            (parseFloat(transaction.Beløp.replace(',', '.')) * 1000).toFixed(0)
        );
        const importId = `YNAB:${amount}:${date}:${occurrence}`;
        return {
            account_id: process.env.YNAB_CREDIT_CARD_ACCOUNT_ID!,
            date,
            amount,
            payee_name: transaction.Beskrivelse,
            cleared: 'cleared' as unknown as ynab.SaveTransaction['cleared'],
            import_id: importId,
        };
    });
};

async function getLatestYnabTransactionDate(
    accountId: string
): Promise<string> {
    try {
        const ynabAPI = new ynab.API(process.env.YNAB_TOKEN!);
        const transactionsResponse =
            await ynabAPI.transactions.getTransactionsByAccount(
                process.env.YNAB_BUDGET_ID!,
                accountId,
                undefined
            );
        const transactions = transactionsResponse.data.transactions;
        // Filter out transfer transactions (where transfer_account_id is not null)
        const nonTransferTransactions = transactions.filter(
            (t) => !t.transfer_account_id
        );
        if (nonTransferTransactions.length === 0) {
            return '1900-01-01';
        }
        // Return the date of the last (most recent) non-transfer transaction
        return nonTransferTransactions[nonTransferTransactions.length - 1].date;
    } catch (error) {
        console.error('Error fetching latest YNAB transaction date:', error);
        // Fallback to a very old date to allow all transactions
        return '1900-01-01';
    }
}

export const config = {
    api: {
        bodyParser: false,
    },
};

export default async function (req: VercelRequest, res: VercelResponse) {
    // Apply basic auth middleware
    basicAuth(req, res, () => {
        if (req.method !== 'POST') {
            return res.status(405).send('Method not allowed');
        }

        const form = new IncomingForm();

        form.parse(req, async (err: any, fields: Fields, files: Files) => {
            if (err) {
                console.error('Form parse error:', err);
                return res.status(400).send('Error parsing form');
            }

            const file = files.csv as File | File[] | undefined;
            if (!file) {
                return res.status(400).send('No CSV file provided');
            }

            // formidable v3: file is an array if multiple: handle both cases
            const csvFile = Array.isArray(file) ? file[0] : file;
            const data = await fs.promises.readFile(csvFile.filepath);
            const csvContent = data.toString('utf-8');

            try {
                // Preprocess CSV: strip quotes from header row
                const lines = csvContent.split(/\r?\n/);
                if (lines.length > 0) {
                    lines[0] = lines[0].replace(/"/g, '');
                }
                const preprocessedCsv = lines.join('\n');

                // Parse CSV data
                const records = parse(preprocessedCsv, {
                    columns: true,
                    skip_empty_lines: true,
                    delimiter: ';',
                    trim: true,
                    skipRecordsWithError: true,
                    fromLine: 1,
                    relaxColumnCount: true,
                    relaxQuotes: true,
                    ltrim: true,
                    rtrim: true,
                    quote: '"',
                }) as CsvTransaction[];

                // Get last sync date from YNAB
                const lastSyncDate = await getLatestYnabTransactionDate(
                    process.env.YNAB_CREDIT_CARD_ACCOUNT_ID!
                );

                // Map CSV transactions to YNAB format
                const ynabTransactions = mapCsvTransactionsToYnabTransactions(
                    records,
                    lastSyncDate
                );

                if (ynabTransactions.length === 0) {
                    return res
                        .status(200)
                        .send('No new transactions to import');
                }

                // Upload to YNAB
                const ynabAPI = new ynab.API(process.env.YNAB_TOKEN!);
                const dto: ynab.SaveTransactionsWrapper = {
                    transactions: ynabTransactions,
                };

                await ynabAPI.transactions.createTransactions(
                    process.env.YNAB_BUDGET_ID!,
                    dto
                );

                res.status(200).send(
                    `Successfully imported ${ynabTransactions.length} transactions`
                );
            } catch (error) {
                console.error('Error processing CSV:', error);
                res.status(500).send('Error processing CSV file');
            }
        });
    });
}
