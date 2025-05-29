import type { VercelRequest, VercelResponse } from '@vercel/node';

export function basicAuth(
    req: VercelRequest,
    res: VercelResponse,
    next: () => void
) {
    // Check if environment variables are set
    if (!process.env.BASIC_AUTH_USER || !process.env.BASIC_AUTH_PASSWORD) {
        console.error('Basic auth credentials not configured');
        return res.status(500).send('Server configuration error');
    }

    // Check for Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Secure Area"');
        return res.status(401).send('Authentication required');
    }

    // Parse credentials
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64')
        .toString()
        .split(':');
    const user = auth[0];
    const pass = auth[1];

    // Verify credentials
    if (
        user === process.env.BASIC_AUTH_USER &&
        pass === process.env.BASIC_AUTH_PASSWORD
    ) {
        next();
    } else {
        res.setHeader('WWW-Authenticate', 'Basic realm="Secure Area"');
        return res.status(401).send('Invalid credentials');
    }
}
