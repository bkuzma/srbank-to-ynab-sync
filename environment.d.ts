declare global {
    namespace NodeJS {
        interface ProcessEnv {
            NODE_ENV: 'development' | 'production';
            BANK_ACCOUNT_KEY: string;
            BANK_CLIENT_SECRET: string;
            BANK_CLIENT_ID: string;
            YNAB_TOKEN: string;
            YNAB_BUDGET_ID: string;
            YNAB_ACCOUNT_ID: string;
            KV_BUCKET: string;
            KV_SECRET: string;
            KV_READ_KEY: string;
            KV_WRITE_KEY: string;
        }
    }
}

export {};
