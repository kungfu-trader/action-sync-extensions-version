import fs from "fs";
import path from "path";
import axios from "axios";
import { Octokit } from "@octokit/rest";
import * as lockfile from "@yarnpkg/lockfile";
import chunk from "lodash.chunk";
import glob from "glob";

export interface Argv {
  token: string;
  apiKey: string;
  owner: string;
  repo: string;
  baseId: string;
  extTableId: string;
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
  params?: { [key: string]: string | number };
};

const DEFAULT_FIELDS = [
  {
    name: "name",
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
];

export const checkExtensions = async (argv: Argv) => {
  const octokit = new Octokit({
    auth: argv.token,
  });
  const currentVersion = getCurrentVersion();
  const extensions: Map<string, string> = getYarnLockInfo(
    fs.readFileSync(path.join(process.cwd(), "yarn.lock"), "utf8")
  );
  const result = [];
  for (const [name, version] of extensions) {
    const item = await getVersionList(octokit, name, version);
    item && result.push(item);
  }
  if (result.length > 0) {
    await refreshExtTableRecords(argv, extensions, currentVersion);
    await refreshRepoTablerecords(argv, result);
  }
};

export const checkConsumers = async (argv: Argv) => {
  const records = await getTableRecords({
    apiKey: argv.apiKey,
    baseId: argv.baseId,
    tableId: argv.extTableId,
  });
  const packages = getPkgNameMap();
  const version = getCurrentVersion();
  const repos = records.reduce((acc: Set<string>, cur: ReposModel) => {
    if (packages.some((v: string) => cur.extensions.includes(v))) {
      acc.add(cur.repo);
    }
    return acc;
  }, new Set());
  for (const repo of repos) {
    const repoRecords = await getTableRecords({
      apiKey: argv.apiKey,
      baseId: argv.baseId,
      tableId: repo,
    });
    const items = packages.reduce((acc: RecordModel[], cur: string) => {
      const target = repoRecords.find((v: RepoExtensionsModel) => v.name === cur);
      if (target && isHitVersion(target.currentVersion, version)) {
        acc.push({
          fields: {
            ...omit(target, ["Created", "id"]) as RepoExtensionsModel,
            latestVersion: version,
          },
          id: target.id,
        });
      }
      return acc;
    }, []);
    if (items.length > 0) {
      updateTableRecords({
        apiKey: argv.apiKey,
        baseId: argv.baseId,
        tableId: repo,
        records: items,
      });
    }
  }
};

const getVersionList = async (
  octokit: any,
  name: string,
  version: string,
  page = 1
): Promise<any> => {
  const per_page = 100;
  const data = await octokit
    .request(
      "GET /orgs/{org}/packages/{package_type}/{package_name}/versions",
      {
        package_type: "npm",
        package_name: name.replace("@kungfu-trader/", ""),
        org: "kungfu-trader",
        state: "active",
        per_page,
        page,
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    )
    .then((res: { data: any; }) => res.data)
    .catch((e: any) => console.error(e));
  if (!data || data.length < per_page) {
    return;
  }
  const latestVersion = data.find((v: { name: string }) =>
    isHitVersion(version, v.name)
  )?.name;
  return latestVersion
    ? {
      latestVersion,
      currentVersion: version,
      name,
    }
    : await getVersionList(octokit, name, version, page + 1);
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

const filterBy = (items = {}) => {
  return Object.entries(items).filter(([key]) =>
    key.startsWith("@kungfu-trader/")
  );
};

const refreshExtTableRecords = async (
  argv: Argv,
  extensions: Map<string, string>,
  version: string
) => {
  const records = await getTableRecords({
    apiKey: argv.apiKey,
    baseId: argv.baseId,
    tableId: argv.extTableId,
  });
  const target = records.find((v: ReposModel) => v.repo === argv.repo);
  const fields = {
    repo: argv.repo,
    extensions: [...extensions.keys()],
    version,
  };
  if (target) {
    updateTableRecords({
      apiKey: argv.apiKey,
      baseId: argv.baseId,
      tableId: argv.extTableId,
      records: [{ fields, id: target.id }],
    });
  } else {
    insertTableRecords({
      apiKey: argv.apiKey,
      baseId: argv.baseId,
      tableId: argv.extTableId,
      records: [{ fields }],
    });
  }
};

const refreshRepoTablerecords = async (argv: Argv, result: Array<RepoExtensionsModel>) => {
  if (result.length === 0) {
    return;
  }
  const records = await getTableRecords({
    apiKey: argv.apiKey,
    baseId: argv.baseId,
    tableId: argv.repo,
  });
  if (!Array.isArray(records)) {
    const table = await createTable({
      apiKey: argv.apiKey,
      baseId: argv.baseId,
      tableName: argv.repo,
    });
    if (!table) return;
  }
  if (records?.length > 0) {
    await deleteTableRecords({
      apiKey: argv.apiKey,
      baseId: argv.baseId,
      tableId: argv.repo,
      ids: records.map((v: { id: string }) => v.id),
    });
  }
  await insertTableRecords({
    apiKey: argv.apiKey,
    baseId: argv.baseId,
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
    .catch((e) => console.error(e.response.data.error));
  if (!res) {
    return [];
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
        .catch((e) => console.error(e.response.data.error));
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
        .catch((e) => console.error(e.response.data.error));
    })
  );
};

const deleteTableRecords = ({
  apiKey,
  baseId,
  tableId,
  ids,
}: AirtableApi) => {
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
        .catch((e) => console.error(e.response.data.error));
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
    .catch((e) => console.error(e.response.data.error));
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

const getCurrentVersion = (): string => {
  const cwd = process.cwd();
  const hasLerna = fs.existsSync(path.join(cwd, "lerna.json"));
  const { version } = getPkgConfig(
    cwd,
    hasLerna ? "lerna.json" : "package.json"
  );
  return version;
};

const omit = (obj: { [s: string]: any }, keys: string[]) => {
  return Object.fromEntries(
    Object.entries(obj).filter(([key]) => !keys.includes(key))
  );
};
