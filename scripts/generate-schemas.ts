import { generateSchemas } from "../src/core/generate-schemas.js";

for (const file of await generateSchemas()) console.log(`wrote\t${file}`);
