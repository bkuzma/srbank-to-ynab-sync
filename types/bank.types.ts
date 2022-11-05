export interface TransactionDTO {
    id: string;
    description?: string;
    cleanedDescription?: string;
    amount?: number;
    date?: number;
    kidOrMessage?: string;
    currencyCode?: string;
    canShowDetails: boolean;
    source: 'RECENT' | 'HISTORIC' | 'ALL';
    bookingStatus: 'BOOKED' | 'PENDING';
    accountName?: string;
    accountKey?: string;
}

export interface TransactionsDTO {
    transactions: TransactionDTO[];
}

export interface TokenDTO {
    access_token: string;
    refresh_token: string;
}
