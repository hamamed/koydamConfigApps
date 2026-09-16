/** Applies the schema. Opening the database already does; this is for deploy scripts. */
import { migrate } from './index.js';

migrate();
console.log('Schema applied.');
