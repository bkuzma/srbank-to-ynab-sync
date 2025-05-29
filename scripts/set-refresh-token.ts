import { Redis } from '@upstash/redis';
require('dotenv').config();

// Initialize Redis client with Vercel's environment variables
const redis = new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
});

async function setRefreshToken() {
    const refreshToken = process.argv[2];

    if (!refreshToken) {
        console.error('Please provide a refresh token as an argument');
        console.error(
            'Usage: yarn ts-node scripts/set-refresh-token.ts "your-refresh-token"'
        );
        process.exit(1);
    }

    try {
        await redis.set('refreshToken', refreshToken);
        console.log('Successfully set refresh token in Redis');
    } catch (error) {
        console.error('Error setting refresh token:', error);
        process.exit(1);
    }
}

setRefreshToken();
