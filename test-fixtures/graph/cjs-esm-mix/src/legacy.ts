import fs = require('fs');
import path from 'node:path';

export const read = (p: string) => fs.readFileSync(path.join('x', p));
