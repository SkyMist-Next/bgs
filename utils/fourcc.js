'use strict';

class FourCC {
    constructor(string) {
        this.intValue = 0;

        for (let i = 0; i < string.length && i < 4; i++) {
            this.intValue = this.intValue << 8 | (string.charCodeAt(i) & 0xFF);
        }
    }

    getIntValue() {
        return this.intValue;
    }
}

module.exports = FourCC;