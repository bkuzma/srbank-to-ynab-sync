import type { VercelRequest, VercelResponse } from '@vercel/node';
import { TokenDTO, TransactionDTO, TransactionsDTO } from '../types/bank.types';
import {
    SaveTransaction,
    SaveTransactionsWrapper,
    TransactionDetail,
    TransactionsResponse,
    UpdateTransaction,
    UpdateTransactionsWrapper,
} from '../types/ynab.types';

require('dotenv').config();
const fetch = require('node-fetch');
const ynab = require('ynab');
const faunadb = require('faunadb');
const { formatInTimeZone } = require('date-fns-tz');
const subDays = require('date-fns/subDays');

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
    return formatInTimeZone(date, 'Europe/Oslo', 'yyyy-MM-dd');
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
        const amount = Number((bankTransaction.amount! * 1000).toFixed(0));

        const importId = `YNAB:${amount}:${date}:${occurrence}`;

        return {
            account_id: process.env.YNAB_ACCOUNT_ID,
            date,
            amount,
            payee_name: bankTransaction.cleanedDescription!,
            cleared:
                bankTransaction.bookingStatus === 'BOOKED'
                    ? 'cleared'
                    : 'uncleared',
            import_id: importId,
        };
    });
};

/*
This attempts to fix a problem whereby uncleared bank transactions have a nice neat
description such as "Netonnet" and the subsequent cleared transaction has a name more
like "*3301 25.12 NOK 250.00 NETONNET SANDNES Kurs: 1.0000". The result is that both
the uncleared and the cleared versions end up in YNAB, and the cleared version has an
unwieldy name.

We try to fix this by checking if cleared bank transactions already have an uncleared
transaction in YNAB, and if so, we update those existing uncleared transactions. If there
is no matching transaction, we simply post them to YNAB as usual.
*/
const dedupeTransactions = (
    bankTransactions: TransactionDTO[],
    ynabTransactions: TransactionDetail[]
): {
    transactionsToClear: UpdateTransaction[];
    transactionsToAdd: SaveTransaction[];
} => {
    const transactionsToClear: UpdateTransaction[] = [];
    const transactionsToAdd: SaveTransaction[] = [];

    bankTransactions.forEach((bankTransaction) => {
        // if it's a pending transaction, we'll send to YNAB
        if (bankTransaction.bookingStatus === 'PENDING') {
            transactionsToAdd.push(
                ...mapBankTransactionsToYnabTransactions([bankTransaction])
            );

            return;
        }

        // else it's a cleared transaction, so we check if there's a matching uncleared
        // transaction in YNAB. if so, we udpate that transaction to be cleared rather
        // than adding a new transaction.

        const matchingTransaction = ynabTransactions.find((ynabTransaction) => {
            if (
                bankTransaction.amount === undefined ||
                ynabTransaction.payee_name === undefined
            ) {
                return false;
            }

            const isMatch =
                ynabTransaction.amount === bankTransaction.amount * 1000 &&
                bankTransaction.description
                    ?.toLowerCase()
                    .includes(ynabTransaction.payee_name.toLowerCase());

            return isMatch;
        });

        // do nothing if the matching YNAB transaction is cleared

        if (!matchingTransaction) {
            transactionsToAdd.push(
                ...mapBankTransactionsToYnabTransactions([bankTransaction])
            );
        } else if (matchingTransaction.cleared === 'uncleared') {
            transactionsToClear.push({
                ...matchingTransaction,
                cleared: 'cleared',
            });
        }
    });

    return {
        transactionsToClear,
        transactionsToAdd,
    };
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
        const ynabAPI = new ynab.API(process.env.YNAB_TOKEN);
        const sinceDate = getDateString(subDays(new Date(), 5));

        const recentYnabTransactionsResponse: TransactionsResponse =
            await ynabAPI.transactions.getTransactionsByAccount(
                process.env.YNAB_BUDGET_ID,
                process.env.YNAB_ACCOUNT_ID,
                sinceDate
            );
        const recentYnabTransactions =
            recentYnabTransactionsResponse.data.transactions;

        const { transactionsToClear, transactionsToAdd } = dedupeTransactions(
            bankTransactions,
            recentYnabTransactions
        );

        if (transactionsToClear.length > 0) {
            console.log(
                `Clearing ${transactionsToClear.length} existing YNAB transaction(s)`
            );

            const dto: UpdateTransactionsWrapper = {
                transactions: transactionsToClear,
            };

            await ynabAPI.transactions.updateTransactions(
                process.env.YNAB_BUDGET_ID,
                dto
            );

            console.log('Transactions marked as cleared');
        }

        if (transactionsToAdd.length > 0) {
            console.log(
                `Sending ${transactionsToAdd.length} new transaction(s) to YNAB...`
            );

            const dto: SaveTransactionsWrapper = {
                transactions: transactionsToAdd,
            };

            await ynabAPI.transactions.createTransactions(
                process.env.YNAB_BUDGET_ID,
                dto
            );

            console.log('Transactions sent to YNAB');
        }
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
