import fs from "fs";
import path from "path";
import axios from "axios";
import chunk from "lodash.chunk";
import { Octokit } from "@octokit/rest";
import * as lockfile from "@yarnpkg/lockfile";
import * as glob from "glob";
export interface Argv {
  token: string;
  apiKey: string;
  owner: string;
  repo: string;
  pullRequestTitle?: string;
  extBaseId: string;
  extTableId: string;
  storeBaseId: string;
  storeTableId: string;
  packages?: string;
  version?: string;
}

type ReposModel = {
  id?: string;
  Created?: string;
  extensions: string[];
  repo: string;
};

type RepoExtensionsModel = {
  id?: string;
  Created?: string;
  name: string;
  currentVersion: string;
  latestVersion: string;
  repo: string;
  Calculation?: string;
  artifactVersion: string;
};

type RecordModel = {
  fields: ReposModel | RepoExtensionsModel;
  id?: string;
  Created?: string;
};

type AirtableApi = {
  apiKey: string;
  baseId: string;
  tableId?: string;
  tableName?: string;
  records?: RecordModel[];
  ids?: string[];
  params?: { [key: string]: any };
};

const DEFAULT_FIELDS = [
  {
    name: "name",
    type: "singleLineText",
  },
  {
    name: "repo",
    type: "singleLineText",
  },
  {
    name: "currentVersion",
    type: "singleLineText",
  },
  {
    name: "latestVersion",
    type: "singleLineText",
  },
  {
    name: "artifactVersion",
    type: "singleLineText",
  },
];

export const manualCheckConsumers = async (argv: Argv) => {
  const octokit = new Octokit({
    auth: argv.token,
  });
  const packages = getPkgNameMap();
  const version = getCurrentVersion(argv);
  if (packages.length === 0 || !version) {
    return;
  }
  return octokit
    .request(
      "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
      {
        owner: "kungfu-trader",
        repo: "action-sync-extensions-version",
        workflow_id: "check-consumers.yml",
        ref: "v1.0-alpha",
        inputs: {
          packages: JSON.stringify(packages),
          version,
        },
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    )
    .catch((e) => console.error(e));
};

export const checkExtensions = async (argv: Argv) => {
  if (!argv.repo.startsWith("kungfu-trader")) {
    return;
  }
  // const extensions: Map<string, string> = getYarnLockInfo(
  //   fs.readFileSync(path.join(process.cwd(), "yarn.lock"), "utf8")
  // );
  const currentVersion = getCurrentVersion(argv);
  const extensions: any = await getOriginYarnLock(argv, currentVersion);
  const result = [];
  for (const [name, version] of extensions) {
    const item = await getVersionList(argv, name, version);
    item && result.push(item);
  }
  if (result.length > 0) {
    await refreshExtTableRecords(argv, extensions);
    await refreshRepoTablerecords(argv, result);
  }
};

export const checkConsumers = async (argv: Argv) => {
  const records =
    (await getTableRecords({
      apiKey: argv.apiKey,
      baseId: argv.extBaseId,
      tableId: argv.extTableId,
    })) || [];
  const packages = argv.packages ? JSON.parse(argv.packages!) : getPkgNameMap();
  const version = argv.version ?? getCurrentVersion(argv);
  const repos = records.reduce((acc: Set<string>, cur: ReposModel) => {
    if (packages.some((v: string) => cur.extensions.includes(v))) {
      acc.add(cur.repo);
    }
    return acc;
  }, new Set());
  for (const repo of repos) {
    const repoRecords =
      (await getTableRecords({
        apiKey: argv.apiKey,
        baseId: argv.extBaseId,
        tableId: repo,
      })) || [];
    const items = packages.reduce((acc: RecordModel[], cur: string) => {
      repoRecords
        .filter((v: RepoExtensionsModel) => v.name === cur)
        .forEach(
          (target: { [x: string]: any; currentVersion?: any; id?: any }) => {
            if (isHitVersion(target.currentVersion, version!)) {
              acc.push({
                fields: {
                  ...(omit(target, [
                    "Created",
                    "id",
                    "Calculation",
                  ]) as RepoExtensionsModel),
                  latestVersion: version!,
                },
                id: target.id,
              });
            }
          }
        );
      return acc;
    }, []);
    if (items.length > 0) {
      updateTableRecords({
        apiKey: argv.apiKey,
        baseId: argv.extBaseId,
        tableId: repo,
        records: items,
      });
    }
  }
};

const getVersionList = async (
  argv: Argv,
  name: string,
  version: string
): Promise<any> => {
  const format = (str: string) =>
    str.replace("-alpha", "").split(".").slice(0, -1).join(".");
  const current = format(version);
  const isAlpha = version.includes("-alpha");
  const data =
    (await getTableRecords({
      apiKey: argv.apiKey,
      baseId: argv.storeBaseId,
      tableId: argv.storeTableId,
      params: {
        filterByFormula: `AND(
        {package-name} = "${name.replace("@kungfu-trader/", "")}",
        FIND("${current}", {package-version})
      )`,
        sort: [{ field: "Created", direction: "desc" }],
      },
    })) || [];
  const latest = data
    .map((v: { [key: string]: string }) => [
      v["package-version"],
      v["repo_name"],
    ])
    .filter(([v]: [string]) =>
      isAlpha
        ? v.includes("-alpha") && format(v) === current
        : !v.includes("-alpha") && format(v) === current
    )
    .find(([v]: [string]) => isHitVersion(version, v));
  return {
    latestVersion: latest?.[0] ?? version,
    currentVersion: version,
    repo:
      latest?.[1] ??
      (await getPackageRepo(argv, name.replace("@kungfu-trader/", ""))) ??
      "",
    name,
    artifactVersion: getCurrentVersion(argv),
  };
};

const isHitVersion = (currentVersion: string, targetVersion: string) => {
  const format = (val: string) =>
    val.replace("v", "").replace("-alpha", "").split(".");
  const target = format(targetVersion);
  const current = format(currentVersion);
  return (
    target.length === current.length &&
    target[target.length - 1] >= current[current.length - 1] &&
    target.slice(0, -1).every((_, i) => +target[i] === +current[i])
  );
};

const refreshExtTableRecords = async (
  argv: Argv,
  extensions: Map<string, string>
) => {
  const records =
    (await getTableRecords({
      apiKey: argv.apiKey,
      baseId: argv.extBaseId,
      tableId: argv.extTableId,
    })) || [];
  const target = records.find((v: ReposModel) => v.repo === argv.repo);
  const fields = {
    repo: argv.repo,
    extensions: [
      ...new Set([...extensions.keys(), ...(target ? target.extensions : [])]),
    ],
  };
  if (target) {
    updateTableRecords({
      apiKey: argv.apiKey,
      baseId: argv.extBaseId,
      tableId: argv.extTableId,
      records: [{ fields, id: target.id }],
    });
  } else {
    insertTableRecords({
      apiKey: argv.apiKey,
      baseId: argv.extBaseId,
      tableId: argv.extTableId,
      records: [{ fields }],
    });
  }
};

const refreshRepoTablerecords = async (
  argv: Argv,
  result: Array<RepoExtensionsModel>
) => {
  if (result.length === 0) {
    return;
  }
  const records = await getTableRecords({
    apiKey: argv.apiKey,
    baseId: argv.extBaseId,
    tableId: argv.repo,
  });
  if (!Array.isArray(records)) {
    const table = await createTable({
      apiKey: argv.apiKey,
      baseId: argv.extBaseId,
      tableName: argv.repo,
    });
    if (!table) return;
  }
  if (records?.length > 0) {
    const currentSimulateVersion = simulateVersion(getCurrentVersion(argv));
    const ids = records
      .filter(
        (v: RepoExtensionsModel) =>
          simulateVersion(v.artifactVersion) === currentSimulateVersion
      )
      .map((v: RepoExtensionsModel) => v.id);
    ids.length > 0 &&
      (await deleteTableRecords({
        apiKey: argv.apiKey,
        baseId: argv.extBaseId,
        tableId: argv.repo,
        ids,
      }));
  }
  await insertTableRecords({
    apiKey: argv.apiKey,
    baseId: argv.extBaseId,
    tableId: argv.repo,
    records: result.map((v) => ({
      fields: v,
    })),
  });
};

const getTableRecords = async ({
  apiKey,
  baseId,
  tableId,
  params = {},
}: AirtableApi): Promise<any> => {
  const res = await axios
    .get(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
      params: {
        ...params,
        pageSize: 100,
      },
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    })
    .then((res) => ({
      offset: res.data.offset,
      data: res.data.records.map((v: RecordModel) => ({
        ...v.fields,
        id: v.id,
      })),
    }))
    .catch((e) => console.error(e.response.data.error, e.response.config));
  if (!res) {
    return false;
  }
  return res.offset
    ? [
        ...res.data,
        ...(await getTableRecords({
          apiKey,
          baseId,
          tableId,
          params: {
            ...params,
            offset: res.offset,
          },
        })),
      ]
    : res.data;
};

const insertTableRecords = ({
  apiKey,
  baseId,
  tableId,
  records,
}: AirtableApi): Promise<void[]> => {
  return Promise.all(
    chunk(records, 10).map((data) => {
      axios
        .post(
          `https://api.airtable.com/v0/${baseId}/${tableId}`,
          { records: data, typecast: true },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
          }
        )
        .then(() =>
          console.log(`insert ${baseId}/${tableId} ${data.length} items`)
        )
        .catch((e) => console.error(e.response.data.error, e.response.config));
    })
  );
};

const updateTableRecords = ({
  apiKey,
  baseId,
  tableId,
  records,
}: AirtableApi) => {
  return Promise.all(
    chunk(records, 10).map((data) => {
      axios
        .put(
          `https://api.airtable.com/v0/${baseId}/${tableId}`,
          { records: data, typecast: true },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
          }
        )
        .then(() =>
          console.log(`update ${baseId}/${tableId} ${data.length} items`)
        )
        .catch((e) => console.error(e.response.data.error, e.response.config));
    })
  );
};

const deleteTableRecords = ({ apiKey, baseId, tableId, ids }: AirtableApi) => {
  return Promise.all(
    chunk(ids, 10).map((records) => {
      axios
        .delete(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
          params: { records },
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
        })
        .then(() =>
          console.log(`delete ${baseId}/${tableId} ${records.length} items`)
        )
        .catch((e) => console.error(e.response.data.error, e.response.config));
    })
  );
};

const createTable = ({ apiKey, baseId, tableName }: AirtableApi) => {
  return axios
    .post(
      `https://api.airtable.com/v0/meta/bases/${baseId}/tables`,
      {
        description: `${tableName} extensions`,
        fields: DEFAULT_FIELDS,
        name: tableName,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      }
    )
    .catch((e) => console.error(e.response.data.error, e.response.config));
};

const getPkgNameMap = (): string[] => {
  const cwd = process.cwd();
  const hasLerna = fs.existsSync(path.join(cwd, "lerna.json"));
  const config = getPkgConfig(cwd, hasLerna ? "lerna.json" : "package.json");
  if (hasLerna) {
    const items = config.packages
      .map((x: string) =>
        glob.sync(`${x}/package.json`).reduce((acc: string[], link) => {
          const { name, publishConfig } = getPkgConfig(cwd, link);
          publishConfig && acc.push(name);
          return acc;
        }, [])
      )
      .flat();
    return items;
  }
  return [config.name];
};

const getPkgConfig = (cwd: string, link: string): { [key: string]: any } => {
  return JSON.parse(fs.readFileSync(path.join(cwd, link), "utf-8"));
};

const getCurrentVersion = (argv: Argv): string => {
  return argv.pullRequestTitle?.split(" v")?.[1] ?? "";
};

const omit = (obj: { [s: string]: any }, keys: string[]) => {
  return Object.fromEntries(
    Object.entries(obj).filter(([key]) => !keys.includes(key))
  );
};

const simulateVersion = (version: string) => {
  const isAlpha = version.includes("-alpha");
  const [major, minor] = version.split(".");
  return `${major}.${minor}${isAlpha ? "-alpha" : ""}`;
};

const filterBy = (items = {}) => {
  return Object.entries(items).filter(([key]) =>
    key.startsWith("@kungfu-trader/")
  );
};

const getPackageRepo = (argv: Argv, packageName: string) => {
  const octokit: any = new Octokit({
    auth: argv.token,
  });
  return octokit
    .request("GET /orgs/{org}/packages/{package_type}/{package_name}", {
      package_type: "npm",
      package_name: packageName,
      org: argv.owner,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
    .then((res: any) => {
      return res.data?.repository?.name;
    })
    .catch((e: any) => console.error(e));
};

const getOriginYarnLock = async (argv: Argv, version: string) => {
  const octokit: any = new Octokit({
    auth: argv.token,
  });
  const res = await octokit
    .request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: argv.owner,
      repo: argv.repo,
      path: "yarn.lock",
      ref: `v${version}`,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
    .catch(() => null);
  if (res?.data?.content) {
    return getYarnLockInfo(
      Buffer.from(res?.data?.content, "base64").toString("utf-8")
    );
  }
};

const getYarnLockInfo = function (content: string) {
  if (!content) {
    return new Map();
  }
  const json = lockfile.parse(content);
  return filterBy(json.object).reduce((acc, [key, value]: any) => {
    acc.set("@" + key.split("@")[1], value.version);
    return acc;
  }, new Map());
};
