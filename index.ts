import { checkExtensions, checkConsumers, Argv } from "./lib";
import { getInput, setFailed } from "@actions/core";
import { context } from "@actions/github";

const main = async function () {
  const argv: Argv = {
    owner: context.payload.repository?.owner.login!,
    repo: context.payload.repository?.name!,
    token: getInput("token"),
    apiKey: getInput("apiKey"),
    baseId: getInput("airtable_ext_baseid"),
    extTableId: getInput("airtable_ext_tableid"),
  };
  if (!argv.apiKey) {
    console.error("has not airtable token");
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
