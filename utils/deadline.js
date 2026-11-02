'use strict';

// A deadline bounds the waiter, not the operation. Owners must retain the original
// promise and dispose resources acquired after cancellation.
function deadline(promise, milliseconds, message, signal) {
    let timer;
    let abort;
    const cancelled = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
        abort = () => reject(signal.reason || new Error('Startup cancelled'));
        if (signal?.aborted) { abort(); }
        else { signal?.addEventListener('abort', abort, { once: true }); }
    });
    return Promise.race([promise, cancelled]).finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    });
}

module.exports = { deadline };
