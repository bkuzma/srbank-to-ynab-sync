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
            FAUNA_KEY: string;
            FAUNA_BASE_URL: string;
            FAUNA_COLLECTION_NAME: string;
            FAUNA_DOCUMENT_ID: string;
        }
    }
}

export {};
