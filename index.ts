import {
  checkExtensions,
  checkConsumers,
  manualCheckConsumers,
  Argv,
} from "./lib";
import { getInput, setFailed } from "@actions/core";
import { context } from "@actions/github";

const main = async function () {
  const argv: Argv = {
    owner: context.payload.repository?.owner.login!,
    repo: context.payload.repository?.name!,
    pullRequestTitle: context.payload?.pull_request?.title,
    token: getInput("token"),
    apiKey: getInput("apiKey"),
    extBaseId: getInput("airtable_ext_baseid"),
    extTableId: getInput("airtable_ext_tableid"),
    storeBaseId: getInput("airtable_store_baseid"),
    storeTableId: getInput("airtable_store_tableid"),
    packages: getInput("packages"),
    version: getInput("version"),
  };

  if (!argv.apiKey && !argv.packages && !argv.version) {
    await manualCheckConsumers(argv);
  }
  if (!argv.apiKey) {
    console.error("has not airtable token");
    return;
  }
  if (argv.packages && argv.version) {
    await checkConsumers(argv);
    return;
  }
  await checkExtensions(argv);
  await checkConsumers(argv);
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    setFailed(error.message);
  });
}
