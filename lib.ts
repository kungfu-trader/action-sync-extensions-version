import fs from "fs";
import path from "path";
import axios from "axios";
import * as lockfile from "@yarnpkg/lockfile";
import chunk from "lodash.chunk";
import glob from "glob";

export interface Argv {
  token: string;
  apiKey: string;
  owner: string;
  repo: string;
  extBaseId: string;
  extTableId: string;
  storeBaseId: string;
  storeTableId: string;
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
];

export const checkExtensions = async (argv: Argv) => {
  const currentVersion = getCurrentVersion();
  const extensions: Map<string, string> = getYarnLockInfo(
    fs.readFileSync(path.join(process.cwd(), "yarn.lock"), "utf8")
  );
  const result = [];
  for (const [name, version] of extensions) {
    const item = await getVersionList(argv, name, version);
    item && result.push(item);
  }
  if (result.length > 0) {
    await refreshExtTableRecords(argv, extensions, currentVersion);
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
  const packages = getPkgNameMap();
  const version = getCurrentVersion();
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
      const target = repoRecords.find(
        (v: RepoExtensionsModel) => v.name === cur
      );
      if (target && isHitVersion(target.currentVersion, version)) {
        acc.push({
          fields: {
            ...(omit(target, ["Created", "id"]) as RepoExtensionsModel),
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
        sort: [{ field: "timestamp", direction: "desc" }],
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
    repo: latest?.[1] ?? "",
    name,
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
  const records =
    (await getTableRecords({
      apiKey: argv.apiKey,
      baseId: argv.extBaseId,
      tableId: argv.extTableId,
    })) || [];
  const target = records.find((v: ReposModel) => v.repo === argv.repo);
  const fields = {
    repo: argv.repo,
    extensions: [...extensions.keys()],
    version,
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
    // if (!table) return;
  }
  if (records?.length > 0) {
    await deleteTableRecords({
      apiKey: argv.apiKey,
      baseId: argv.extBaseId,
      tableId: argv.repo,
      ids: records.map((v: { id: string }) => v.id),
    });
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
