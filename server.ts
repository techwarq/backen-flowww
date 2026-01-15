import http from 'http';
import { requestHandler } from './src/handler.js';
import logger from './src/log.js';

const PORT = 3000;

const server = http.createServer(requestHandler);

server.listen(PORT, () => {
    logger.info(`Server listening on http://localhost:${PORT}`);
    console.log(`> Server ready on http://localhost:${PORT}`);
});
