'use strict';

async function launch(createServer, processObject = process) {
    let server;
    try {
        server = createServer();
        await server.start();
    }
    catch {
        // Startup errors can contain secrets. BaseServer records a safe diagnostic.
        if (!server) {
            console.error('Server configuration failed');
            processObject.exitCode = 1;
            return;
        }
    }
    const result = await server.closed;
    processObject.exitCode = result.exitCode;
    // Library stop() never exits. A CLI must also terminate stuck native handles.
    if (result.forced) { processObject.exit(result.exitCode); }
    return result;
}

module.exports = { launch };
