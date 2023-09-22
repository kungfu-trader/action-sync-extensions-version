import { checkConsumers, checkExtensions, Argv } from "./lib";
// import * as yargs from 'yargs';
const yargs = require("yargs");
const cmdArgv = yargs(process.argv.slice(2))
  .option("token", { description: "token", type: "string", default: "" })
  .option("apiKey", { description: "apiKey", type: "string", default: "" })
  .option("owner", { description: "owner", type: "string" })
  .option("repo", { description: "repo", type: "string" })
  .option("baseId", {
    description: "baseId",
    type: "string",
    default: "appiIKDIDD1CSLQgx",
  })
  .option("extTableId", {
    description: "extTableId",
    type: "string",
    default: "tbl5YM7NkZz6SFQM0",
  })
  .help()
  .parseSync();

const argv: Argv = {
  token: cmdArgv.token,
  apiKey: cmdArgv.apiKey,
  owner: cmdArgv.owner,
  repo: cmdArgv.repo,
  baseId: cmdArgv.baseId,
  extTableId: cmdArgv.extTableId,
};

async function dispatch() {
  await checkExtensions(argv);
  await checkConsumers(argv);
}

dispatch();
