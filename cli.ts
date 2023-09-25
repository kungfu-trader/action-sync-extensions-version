import { checkConsumers, checkExtensions, Argv } from "./lib";
// import * as yargs from 'yargs';
const yargs = require("yargs");
const cmdArgv = yargs(process.argv.slice(2))
  .option("token", { description: "token", type: "string", default: "" })
  .option("apiKey", { description: "apiKey", type: "string", default: "" })
  .option("owner", { description: "owner", type: "string" })
  .option("repo", { description: "repo", type: "string" })
  .option("extBaseId", {
    description: "extBaseId",
    type: "string",
    default: "appiIKDIDD1CSLQgx",
  })
  .option("extTableId", {
    description: "extTableId",
    type: "string",
    default: "tbl5YM7NkZz6SFQM0",
  })
  .option("storeBaseId", {
    description: "storeBaseId",
    type: "string",
    default: "appfcHSwqKUfXxCOc",
  })
  .option("storeTableId", {
    description: "storeTableId",
    type: "string",
    default: "tblzCsHS1NcY6LLOb",
  })
  .help()
  .parseSync();

const argv: Argv = {
  token: cmdArgv.token,
  apiKey: cmdArgv.apiKey,
  owner: cmdArgv.owner,
  repo: cmdArgv.repo,
  extBaseId: cmdArgv.extBaseId,
  extTableId: cmdArgv.extTableId,
  storeBaseId: cmdArgv.storeBaseId,
  storeTableId: cmdArgv.storeTableId,
};

async function dispatch() {
  await checkExtensions(argv);
  await checkConsumers(argv);
}

dispatch();
