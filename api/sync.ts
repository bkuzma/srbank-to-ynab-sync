import type { VercelRequest, VercelResponse } from '@vercel/node';
import { TokenDTO, TransactionDTO, TransactionsDTO } from '../types/bank.types';
import { SaveTransaction, SaveTransactionsWrapper } from '../types/ynab.types';

require('dotenv').config();
const fetch = require('node-fetch');
const ynab = require('ynab');
const faunadb = require('faunadb');
const { zonedTimeToUtc, utcToZonedTime, format } = require('date-fns-tz');

const q = faunadb.query;
const client = new faunadb.Client({
    secret: process.env.FAUNA_KEY,
    endpoint: process.env.FAUNA_BASE_URL,
});

enum KV_KEY {
    REFRESH_TOKEN = 'refreshToken',
    LAST_SYNC_DATE = 'lastSyncDate',
}

const getValueFromBucket = async (key: string): Promise<string> => {
    const value = await client.query(
        q.Get(
            q.Ref(
                q.Collection(process.env.FAUNA_COLLECTION_NAME),
                process.env.FAUNA_DOCUMENT_ID
            )
        )
    );
    return value.data[key];
};

const setValueInBucket = async (key: KV_KEY, value: string) => {
    await client.query(
        q.Update(
            q.Ref(
                q.Collection(process.env.FAUNA_COLLECTION_NAME),
                process.env.FAUNA_DOCUMENT_ID
            ),
            {
                data: {
                    [key]: value,
                },
            }
        )
    );
};

const fetchToken = async (
    refreshToken: string,
    clientId: string,
    clientSecret: string
): Promise<TokenDTO> => {
    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
    });

    const response = await fetch('https://api-auth.sparebank1.no/oauth/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
    });

    const json = (await response.json()) as TokenDTO;

    return json;
};

const fetchBankTransactions = async (
    accessToken: string,
    accountKey: string,
    fromDate: string
): Promise<TransactionDTO[]> => {
    const transactionsResponse = await fetch(
        'https://api.sparebank1.no/personal/banking/transactions?' +
            new URLSearchParams({ accountKey, fromDate }),
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/vnd.sparebank1.v1+json;charset=utf-8',
            },
        }
    );

    const transactionsDTO: TransactionsDTO =
        (await transactionsResponse.json()) as TransactionsDTO;

    return transactionsDTO.transactions;
};

const getDateString = (date: Date): string => {
    const zonedDate = utcToZonedTime(date, 'Europe/Oslo');
    return zonedDate.format('YYYY-MM-dd');
};

const mapBankTransactionsToYnabTransactions = (
    bankTransactions: TransactionDTO[]
): SaveTransaction[] => {
    const occurenceMap: { [key: string]: number } = {};
    return bankTransactions.map((bankTransaction) => {
        const transactionKey = `${bankTransaction.date}${bankTransaction.amount}`;

        if (!occurenceMap[transactionKey]) {
            occurenceMap[transactionKey] = 1;
        } else {
            occurenceMap[transactionKey] += 1;
        }

        const occurrence = occurenceMap[transactionKey];
        const date = getDateString(new Date(bankTransaction.date!));

        const importId = `YNAB:${
            bankTransaction.amount! * 1000
        }:${date}:${occurrence}`;

        return {
            account_id: process.env.YNAB_ACCOUNT_ID,
            date,
            amount: bankTransaction.amount! * 1000,
            payee_name: bankTransaction.cleanedDescription!,
            cleared:
                bankTransaction.bookingStatus === 'BOOKED'
                    ? 'cleared'
                    : 'uncleared',
            import_id: importId,
        };
    });
};

const sync = async () => {
    console.log('Getting new access token...');

    const refreshToken = await getValueFromBucket(KV_KEY.REFRESH_TOKEN);

    if (!refreshToken) {
        throw new Error('No refresh token found');
    }

    const { access_token: accessToken, refresh_token: newRefreshToken } =
        await fetchToken(
            refreshToken,
            process.env.BANK_CLIENT_ID,
            process.env.BANK_CLIENT_SECRET
        );
    await setValueInBucket(KV_KEY.REFRESH_TOKEN, newRefreshToken);

    console.log('Refresh token saved');

    const todayDate = getDateString(new Date());
    let lastSyncDate = await getValueFromBucket(KV_KEY.LAST_SYNC_DATE);

    if (!lastSyncDate) {
        lastSyncDate = todayDate;
    }

    console.log(`Getting bank transactions from ${lastSyncDate} ...`);

    const bankTransactions = await fetchBankTransactions(
        accessToken,
        process.env.BANK_ACCOUNT_KEY,
        lastSyncDate
    );

    console.log(`Got ${bankTransactions.length} bank transactions`);

    if (bankTransactions.length === 0) {
        console.log('No new transactions');
    } else {
        const ynabTransactions =
            mapBankTransactionsToYnabTransactions(bankTransactions);

        console.log('Sending transactions to YNAB...');

        const ynabAPI = new ynab.API(process.env.YNAB_TOKEN);
        const dto: SaveTransactionsWrapper = {
            transactions: ynabTransactions,
        };

        await ynabAPI.transactions.createTransactions(
            process.env.YNAB_BUDGET_ID,
            dto
        );

        console.log('Transactions sent to YNAB');
    }

    if (todayDate !== lastSyncDate) {
        await setValueInBucket(KV_KEY.LAST_SYNC_DATE, todayDate);
    }

    console.log('Saved sync date');
};

export default async function (req: VercelRequest, res: VercelResponse) {
    await sync();

    res.send('Successfully synced!');
}
