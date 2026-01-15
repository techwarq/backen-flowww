import 'dotenv/config';
import http from 'http';
import { requestHandler } from './src/handler.js';
import logger from './src/log.js';
import { setGlobalPassphrase } from './src/profiles/store.js';

// Set global passphrase for profile encryption
const passphrase = process.env.PROFILE_PASSPHRASE || 'default-flowdesk-passphrase-2024';
setGlobalPassphrase(passphrase);
logger.info('Profile encryption passphrase configured.');

const PORT = 3000;

const server = http.createServer(requestHandler);

server.listen(PORT, () => {
    logger.info(`Server listening on http://localhost:${PORT}`);
    console.log(`> Server ready on http://localhost:${PORT}`);
});
