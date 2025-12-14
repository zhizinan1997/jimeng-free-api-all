import path from 'path';
import _util from 'util';

import 'colors';
import _ from 'lodash';
import fs from 'fs-extra';
import { format as dateFormat } from 'date-fns';

import config from './config.ts';
import util from './util.ts';

const isVercelEnv = process.env.VERCEL;

// 延迟导入数据库模块，避免循环依赖
let dbModule: any = null;
let dbLoadAttempted = false;

function getDb() {
    if (!dbLoadAttempted) {
        dbLoadAttempted = true;
        try {
            // 尝试多种导入方式
            const mod = require('./database');
            dbModule = mod.default || mod;
        } catch (e) {
            // 初始化阶段可能还没准备好
            console.error('[Logger] Failed to load database module:', e.message);
        }
    }
    return dbModule;
}

class LogWriter {

    #buffers = [];

    constructor() {
        !isVercelEnv && fs.ensureDirSync(config.system.logDirPath);
        !isVercelEnv && this.work();
    }

    push(content) {
        const buffer = Buffer.from(content);
        this.#buffers.push(buffer);
    }

    writeSync(buffer) {
        !isVercelEnv && fs.appendFileSync(path.join(config.system.logDirPath, `/${util.getDateString()}.log`), buffer);
    }

    async write(buffer) {
        !isVercelEnv && await fs.appendFile(path.join(config.system.logDirPath, `/${util.getDateString()}.log`), buffer);
    }

    flush() {
        if(!this.#buffers.length) return;
        !isVercelEnv && fs.appendFileSync(path.join(config.system.logDirPath, `/${util.getDateString()}.log`), Buffer.concat(this.#buffers));
    }

    work() {
        if (!this.#buffers.length) return setTimeout(this.work.bind(this), config.system.logWriteInterval);
        const buffer = Buffer.concat(this.#buffers);
        this.#buffers = [];
        this.write(buffer)
        .finally(() => setTimeout(this.work.bind(this), config.system.logWriteInterval))
        .catch(err => console.error("Log write error:", err));
    }

}

class LogText {

    /** @type {string} 日志级别 */
    level;
    /** @type {string} 日志文本 */
    text;
    /** @type {string} 日志来源 */
    source;
    /** @type {Date} 日志发生时间 */
    time = new Date();

    constructor(level, ...params) {
        this.level = level;
        this.text = _util.format.apply(null, params);
        this.source = this.#getStackTopCodeInfo();
    }

    #getStackTopCodeInfo() {
        const unknownInfo = { name: "unknown", codeLine: 0, codeColumn: 0 };
        const stackArray = new Error().stack.split("\n");
        const text = stackArray[4];
        if (!text)
            return unknownInfo;
        const match = text.match(/at (.+) \((.+)\)/) || text.match(/at (.+)/);
        if (!match || !_.isString(match[2] || match[1]))
            return unknownInfo;
        const temp = match[2] || match[1];
        const _match = temp.match(/([a-zA-Z0-9_\-\.]+)\:(\d+)\:(\d+)$/);
        if (!_match)
            return unknownInfo;
        const [, scriptPath, codeLine, codeColumn] = _match as any;
        return {
            name: scriptPath ? scriptPath.replace(/.js$/, "") : "unknown",
            path: scriptPath || null,
            codeLine: parseInt(codeLine || 0),
            codeColumn: parseInt(codeColumn || 0)
        };
    }

    toString() {
        return `[${dateFormat(this.time, "yyyy-MM-dd HH:mm:ss.SSS")}][${this.level}][${this.source.name}<${this.source.codeLine},${this.source.codeColumn}>] ${this.text}`;
    }

    // 简化版字符串，用于数据库存储
    toSimpleString() {
        return `[${this.source.name}] ${this.text}`;
    }

}

class Logger {

    /** @type {Object} 系统配置 */
    config = {};
    /** @type {Object} 日志级别映射 */
    static Level = {
        Success: "success",
        Info: "info",
        Log: "log",
        Debug: "debug",
        Warning: "warning",
        Error: "error",
        Fatal: "fatal"
    };
    /** @type {Object} 日志级别文本颜色樱色 */
    static LevelColor = {
        [Logger.Level.Success]: "green",
        [Logger.Level.Info]: "brightCyan",
        [Logger.Level.Debug]: "white",
        [Logger.Level.Warning]: "brightYellow",
        [Logger.Level.Error]: "brightRed",
        [Logger.Level.Fatal]: "red"
    };
    #writer;

    constructor() {
        this.#writer = new LogWriter();
    }

    #saveToDb(level: string, text: string) {
        try {
            // 过滤掉仪表盘请求和静态文件请求
            if (text.includes('/dashboard') || 
                text.includes('/favicon.ico') || 
                text.includes('/.well-known') ||
                text.includes('request is not supported')) {
                return;
            }
            
            const db = getDb();
            if (db && db.addLog) {
                // 映射日志级别到数据库格式
                const dbLevel = level === 'warning' ? 'WARN' : level.toUpperCase();
                // 简化日志消息
                let simpleText = text;
                // 移除来源信息 [xxx.ts]
                simpleText = simpleText.replace(/^\[[\w.]+\]\s*/, '');
                db.addLog(dbLevel, simpleText);
            }
        } catch (e) {
            // 忽略数据库错误，不影响主流程
        }
    }

    header() {
        this.#writer.writeSync(Buffer.from(`\n\n===================== LOG START ${dateFormat(new Date(), "yyyy-MM-dd HH:mm:ss.SSS")} =====================\n\n`));
    }

    footer() {
        this.#writer.flush();  //将未写入文件的日志缓存写入
        this.#writer.writeSync(Buffer.from(`\n\n===================== LOG END ${dateFormat(new Date(), "yyyy-MM-dd HH:mm:ss.SSS")} =====================\n\n`));
    }

    success(...params) {
        const logText = new LogText(Logger.Level.Success, ...params);
        const content = logText.toString();
        console.info(content[Logger.LevelColor[Logger.Level.Success]]);
        this.#writer.push(content + "\n");
        this.#saveToDb('INFO', logText.toSimpleString());
    }

    info(...params) {
        const logText = new LogText(Logger.Level.Info, ...params);
        const content = logText.toString();
        console.info(content[Logger.LevelColor[Logger.Level.Info]]);
        this.#writer.push(content + "\n");
        this.#saveToDb('INFO', logText.toSimpleString());
    }

    log(...params) {
        const logText = new LogText(Logger.Level.Log, ...params);
        const content = logText.toString();
        console.log(content[Logger.LevelColor[Logger.Level.Log]]);
        this.#writer.push(content + "\n");
        this.#saveToDb('INFO', logText.toSimpleString());
    }

    debug(...params) {
        if(!config.system.debug) return;  //非调试模式忽略debug
        const logText = new LogText(Logger.Level.Debug, ...params);
        const content = logText.toString();
        console.debug(content[Logger.LevelColor[Logger.Level.Debug]]);
        this.#writer.push(content + "\n");
    }

    warn(...params) {
        const logText = new LogText(Logger.Level.Warning, ...params);
        const content = logText.toString();
        console.warn(content[Logger.LevelColor[Logger.Level.Warning]]);
        this.#writer.push(content + "\n");
        this.#saveToDb('WARN', logText.toSimpleString());
    }

    error(...params) {
        const logText = new LogText(Logger.Level.Error, ...params);
        const content = logText.toString();
        console.error(content[Logger.LevelColor[Logger.Level.Error]]);
        this.#writer.push(content);
        this.#saveToDb('ERROR', logText.toSimpleString());
    }

    fatal(...params) {
        const logText = new LogText(Logger.Level.Fatal, ...params);
        const content = logText.toString();
        console.error(content[Logger.LevelColor[Logger.Level.Fatal]]);
        this.#writer.push(content);
        this.#saveToDb('ERROR', logText.toSimpleString());
    }

    destory() {
        this.#writer.destory();
    }

}

export default new Logger();