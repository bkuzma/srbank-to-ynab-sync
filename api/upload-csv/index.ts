import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parse } from 'csv-parse/sync';
import { formatInTimeZone } from 'date-fns-tz';
import * as ynab from 'ynab';
import { Redis } from '@upstash/redis';
import { IncomingForm, Fields, Files, File } from 'formidable';
import fs from 'fs';
import { basicAuth } from '../middleware';

require('dotenv').config();

// Extend VercelRequest to include formidable file (not needed, handled in handler)

// Runtime check for required env variables
const requiredEnv = [
    'YNAB_TOKEN',
    'YNAB_BUDGET_ID',
    'YNAB_CREDIT_CARD_ACCOUNT_ID',
];
for (const key of requiredEnv) {
    if (!process.env[key]) throw new Error(`Missing env variable: ${key}`);
}

// Initialize Redis client
const redis = Redis.fromEnv();

enum KV_KEY {
    LAST_SYNC_DATE = 'lastSyncDate',
}

const getValueFromKV = async (key: string): Promise<string | null> => {
    return await redis.get(key);
};

const getDateString = (date: Date): string => {
    return formatInTimeZone(date, 'Europe/Oslo', 'yyyy-MM-dd');
};

// Add date validation function
function isValidYnabDate(date: Date): boolean {
    const now = new Date();
    const fiveYearsAgo = new Date();
    fiveYearsAgo.setFullYear(now.getFullYear() - 5);

    return date <= now && date >= fiveYearsAgo;
}

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

function getKjøpsdato(transaction: any): string | undefined {
    // Try both with and without quotes, and with different cases
    return (
        transaction['Kjøpsdato'] ||
        transaction['kjøpsdato'] ||
        transaction.Kjøpsdato ||
        transaction.kjøpsdato
    );
}

function getPosteringsdato(transaction: any): string | undefined {
    // Try both with and without quotes, and with different cases
    return (
        transaction['Posteringsdato'] ||
        transaction['posteringsdato'] ||
        transaction.Posteringsdato ||
        transaction.posteringsdato
    );
}

const mapCsvTransactionsToYnabTransactions = (
    csvTransactions: CsvTransaction[],
    lastSyncDate: string
): ynab.SaveTransaction[] => {
    console.log('Last sync date from YNAB:', lastSyncDate);
    const occurenceMap: { [key: string]: number } = {};
    const filtered = csvTransactions.filter((transaction, idx) => {
        const kjøpsdato = getKjøpsdato(transaction);
        if (!kjøpsdato) {
            console.log('No kjøpsdato found for transaction:', transaction);
            return false;
        }
        const cleaned = cleanDate(kjøpsdato);
        const transactionDate = new Date(cleaned);
        const transactionDateStr = getDateString(transactionDate);

        // Debug logging with detailed date comparison
        console.log('Processing transaction:', {
            rawDate: kjøpsdato,
            cleanedDate: cleaned,
            parsedDate: transactionDate.toISOString(),
            formattedDate: transactionDateStr,
            lastSyncDate,
            isAfterLastSync: transactionDateStr > lastSyncDate,
            comparison: {
                transactionDateStr,
                lastSyncDate,
                result: transactionDateStr > lastSyncDate,
            },
        });

        // Validate date is within YNAB's allowed range
        if (!isValidYnabDate(transactionDate)) {
            console.warn(`Skipping transaction with invalid date: ${cleaned}`);
            return false;
        }

        const shouldInclude = transactionDateStr > lastSyncDate;
        if (!shouldInclude) {
            console.log('Skipping transaction - date not after last sync:', {
                transactionDate: transactionDateStr,
                lastSyncDate,
                comparison: transactionDateStr > lastSyncDate,
            });
        }
        return shouldInclude;
    });

    console.log('Filtered transactions count:', filtered.length);
    if (filtered.length === 0) {
        console.log('No transactions passed the date filter');
    }
    return filtered.map((transaction) => {
        const kjøpsdato = getKjøpsdato(transaction);
        const posteringsdato = getPosteringsdato(transaction);
        const transactionKey = `${kjøpsdato}${transaction.Beløp}`;
        if (!occurenceMap[transactionKey]) {
            occurenceMap[transactionKey] = 1;
        } else {
            occurenceMap[transactionKey] += 1;
        }
        const occurrence = occurenceMap[transactionKey];
        const date = cleanDate(kjøpsdato);

        // Check if transaction is posted (cleared)
        const isPosted =
            posteringsdato && new Date(cleanDate(posteringsdato)) <= new Date();

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
            cleared: (isPosted
                ? 'cleared'
                : 'uncleared') as ynab.SaveTransaction['cleared'],
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
        // Sort transactions by date in descending order (newest first)
        const sortedTransactions = nonTransferTransactions.sort(
            (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
        );
        // Return the date of the most recent transaction
        return sortedTransactions[0].date;
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
                    // Handle accented characters in headers
                    columns: (headers: string[]) => {
                        return headers.map((header) =>
                            header.replace(/^"+|"+$/g, '').trim()
                        );
                    },
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
