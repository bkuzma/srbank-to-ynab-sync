import { TransactionDTO, TransactionsDTO } from './bank.types';
import { SaveTransaction, SaveTransactionsWrapper } from './ynab.types';

require('dotenv').config();
const { writeFileSync, readFileSync } = require('fs');
const { join } = require('path');
const ynab = require('ynab');

const getRefreshToken = () => {
    const value: string = readFileSync(
        join(__dirname, './refreshToken.txt'),
        'utf-8'
    );
    return value;
};

const getLastSyncDate = () => {
    const value: string = readFileSync(
        join(__dirname, './lastSyncDate.txt'),
        'utf-8'
    );
    return value;
};

const saveRefreshToken = (value: string) => {
    writeFileSync(join(__dirname, './refreshToken.txt'), value);
};

const saveLastSyncDate = (value: string) => {
    writeFileSync(join(__dirname, './lastSyncDate.txt'), value);
};

const fetchToken = async (
    refreshToken: string,
    clientId: string,
    clientSecret: string
): Promise<{ access_token: string; refresh_token: string }> => {
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

    const json = await response.json();

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

    const transactionsDTO: TransactionsDTO = await transactionsResponse.json();

    return transactionsDTO.transactions;
};

const getDateString = (date: Date) => {
    return date.toISOString().split('T')[0];
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

const main = async () => {
    console.log('Getting new access token...');

    const refreshToken = getRefreshToken();
    const { access_token: accessToken, refresh_token: newRefreshToken } =
        await fetchToken(
            refreshToken,
            process.env.BANK_CLIENT_ID,
            process.env.BANK_CLIENT_SECRET
        );
    saveRefreshToken(newRefreshToken);

    console.log('Token saved');

    let lastSyncDate;
    const todayDate = getDateString(new Date());

    try {
        lastSyncDate = getLastSyncDate();
    } catch (e) {
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
        return;
    }

    const ynabTransactions =
        mapBankTransactionsToYnabTransactions(bankTransactions);

    console.log('Sending transactions to YNAB...');

    // post transactions to YNAB
    const ynabAPI = new ynab.API(process.env.YNAB_TOKEN);
    const dto: SaveTransactionsWrapper = {
        transactions: ynabTransactions,
    };
    console.log('ynabTransactions', ynabTransactions);

    try {
        await ynabAPI.transactions.createTransactions(
            process.env.YNAB_BUDGET_ID,
            dto
        );
    } catch (e) {
        console.log('e', e);
    }

    console.log('Transactions sent to YNAB');

    saveLastSyncDate(todayDate);
};

main();
