"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkConsumers = exports.checkExtensions = exports.manualCheckConsumers = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const axios_1 = __importDefault(require("axios"));
const lodash_chunk_1 = __importDefault(require("lodash.chunk"));
const rest_1 = require("@octokit/rest");
const lockfile = __importStar(require("@yarnpkg/lockfile"));
const glob = __importStar(require("glob"));
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
const manualCheckConsumers = async (argv) => {
    const octokit = new rest_1.Octokit({
        auth: argv.token,
    });
    const packages = getPkgNameMap();
    const version = getCurrentVersion();
    if (packages.length === 0 || !version) {
        return;
    }
    return octokit
        .request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
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
    })
        .catch((e) => console.error(e));
};
exports.manualCheckConsumers = manualCheckConsumers;
const checkExtensions = async (argv) => {
    const currentVersion = getCurrentVersion();
    const extensions = getYarnLockInfo(fs_1.default.readFileSync(path_1.default.join(process.cwd(), "yarn.lock"), "utf8"));
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
exports.checkExtensions = checkExtensions;
const checkConsumers = async (argv) => {
    const records = (await getTableRecords({
        apiKey: argv.apiKey,
        baseId: argv.extBaseId,
        tableId: argv.extTableId,
    })) || [];
    const packages = argv.packages ? JSON.parse(argv.packages) : getPkgNameMap();
    const version = argv.version ?? getCurrentVersion();
    const repos = records.reduce((acc, cur) => {
        if (packages.some((v) => cur.extensions.includes(v))) {
            acc.add(cur.repo);
        }
        return acc;
    }, new Set());
    for (const repo of repos) {
        const repoRecords = (await getTableRecords({
            apiKey: argv.apiKey,
            baseId: argv.extBaseId,
            tableId: repo,
        })) || [];
        const items = packages.reduce((acc, cur) => {
            const target = repoRecords.find((v) => v.name === cur);
            if (target && isHitVersion(target.currentVersion, version)) {
                acc.push({
                    fields: {
                        ...omit(target, [
                            "Created",
                            "id",
                            "Calculation",
                        ]),
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
exports.checkConsumers = checkConsumers;
const getVersionList = async (argv, name, version) => {
    const format = (str) => str.replace("-alpha", "").split(".").slice(0, -1).join(".");
    const current = format(version);
    const isAlpha = version.includes("-alpha");
    const data = (await getTableRecords({
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
        .map((v) => [
        v["package-version"],
        v["repo_name"],
    ])
        .filter(([v]) => isAlpha
        ? v.includes("-alpha") && format(v) === current
        : !v.includes("-alpha") && format(v) === current)
        .find(([v]) => isHitVersion(version, v));
    return {
        latestVersion: latest?.[0] ?? version,
        currentVersion: version,
        repo: latest?.[1] ?? "",
        name,
    };
};
const isHitVersion = (currentVersion, targetVersion) => {
    const format = (val) => val.replace("v", "").replace("-alpha", "").split(".");
    const target = format(targetVersion);
    const current = format(currentVersion);
    return (target.length === current.length &&
        target[target.length - 1] >= current[current.length - 1] &&
        target.slice(0, -1).every((_, i) => +target[i] === +current[i]));
};
const getYarnLockInfo = function (content) {
    if (!content) {
        return new Map();
    }
    const json = lockfile.parse(content);
    return filterBy(json.object).reduce((acc, [key, value]) => {
        acc.set("@" + key.split("@")[1], value.version);
        return acc;
    }, new Map());
};
const filterBy = (items = {}) => {
    return Object.entries(items).filter(([key]) => key.startsWith("@kungfu-trader/"));
};
const refreshExtTableRecords = async (argv, extensions, version) => {
    const records = (await getTableRecords({
        apiKey: argv.apiKey,
        baseId: argv.extBaseId,
        tableId: argv.extTableId,
    })) || [];
    const target = records.find((v) => v.repo === argv.repo);
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
    }
    else {
        insertTableRecords({
            apiKey: argv.apiKey,
            baseId: argv.extBaseId,
            tableId: argv.extTableId,
            records: [{ fields }],
        });
    }
};
const refreshRepoTablerecords = async (argv, result) => {
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
        if (!table)
            return;
    }
    if (records?.length > 0) {
        await deleteTableRecords({
            apiKey: argv.apiKey,
            baseId: argv.extBaseId,
            tableId: argv.repo,
            ids: records.map((v) => v.id),
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
const getTableRecords = async ({ apiKey, baseId, tableId, params = {}, }) => {
    const res = await axios_1.default
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
        data: res.data.records.map((v) => ({
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
const insertTableRecords = ({ apiKey, baseId, tableId, records, }) => {
    return Promise.all((0, lodash_chunk_1.default)(records, 10).map((data) => {
        axios_1.default
            .post(`https://api.airtable.com/v0/${baseId}/${tableId}`, { records: data, typecast: true }, {
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
        })
            .then(() => console.log(`insert ${tableId} ${records?.map((v) => v.fields)}`))
            .catch((e) => console.error(e.response.data.error, e.response.config));
    }));
};
const updateTableRecords = ({ apiKey, baseId, tableId, records, }) => {
    return Promise.all((0, lodash_chunk_1.default)(records, 10).map((data) => {
        axios_1.default
            .put(`https://api.airtable.com/v0/${baseId}/${tableId}`, { records: data, typecast: true }, {
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
        })
            .then(() => console.log(`update ${tableId} ${records?.map((v) => v.fields)}`))
            .catch((e) => console.error(e.response.data.error, e.response.config));
    }));
};
const deleteTableRecords = ({ apiKey, baseId, tableId, ids }) => {
    return Promise.all((0, lodash_chunk_1.default)(ids, 10).map((records) => {
        axios_1.default
            .delete(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
            params: { records },
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
        })
            .catch((e) => console.error(e.response.data.error, e.response.config));
    }));
};
const createTable = ({ apiKey, baseId, tableName }) => {
    return axios_1.default
        .post(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, {
        description: `${tableName} extensions`,
        fields: DEFAULT_FIELDS,
        name: tableName,
    }, {
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
    })
        .catch((e) => console.error(e.response.data.error, e.response.config));
};
const getPkgNameMap = () => {
    const cwd = process.cwd();
    const hasLerna = fs_1.default.existsSync(path_1.default.join(cwd, "lerna.json"));
    const config = getPkgConfig(cwd, hasLerna ? "lerna.json" : "package.json");
    if (hasLerna) {
        const items = config.packages
            .map((x) => glob.sync(`${x}/package.json`).reduce((acc, link) => {
            const { name, publishConfig } = getPkgConfig(cwd, link);
            publishConfig && acc.push(name);
            return acc;
        }, []))
            .flat();
        return items;
    }
    return [config.name];
};
const getPkgConfig = (cwd, link) => {
    return JSON.parse(fs_1.default.readFileSync(path_1.default.join(cwd, link), "utf-8"));
};
const getCurrentVersion = () => {
    const cwd = process.cwd();
    const hasLerna = fs_1.default.existsSync(path_1.default.join(cwd, "lerna.json"));
    const { version } = getPkgConfig(cwd, hasLerna ? "lerna.json" : "package.json");
    return version;
};
const omit = (obj, keys) => {
    return Object.fromEntries(Object.entries(obj).filter(([key]) => !keys.includes(key)));
};
