import fs from 'fs';
import path from 'path';
import logger from './logger.js';

// 自动加载本地被忽略的持久化环境变量（例如账号池加密密钥），重启保持稳定
function loadLocalEnvFile(filePath: string) {
    try {
        if (!fs.existsSync(filePath)) return;
        const content = fs.readFileSync(filePath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const separator = trimmed.indexOf('=');
            if (separator <= 0) continue;
            const key = trimmed.slice(0, separator).trim();
            const value = trimmed.slice(separator + 1).trim();
            if (!process.env[key] && value) {
                process.env[key] = value;
            }
        }
    } catch (e: any) {
        logger.warn(`加载本地环境文件 ${filePath} 失败: ${e?.message || e}`);
    }
}

loadLocalEnvFile(path.resolve('./data/account-pool.env'));
loadLocalEnvFile(path.resolve('./portable/config/portable.env'));

// 允许无限量的监听器
process.setMaxListeners(Infinity);
// 输出未捕获异常
process.on("uncaughtException", (err, origin) => {
    logger.error(`An unhandled error occurred: ${origin}`, err);
});
// 输出未处理的Promise.reject
process.on("unhandledRejection", (_, promise) => {
    promise.catch(err => logger.error("An unhandled rejection occurred:", err));
});
// 输出系统警告信息
process.on("warning", warning => logger.warn("System warning: ", warning));
// 进程退出监听
process.on("exit", () => {
    logger.info("Service exit");
    logger.footer();
});
// 进程被kill
process.on("SIGTERM", () => {
    logger.warn("received kill signal");
    process.exit(2);
});
// Ctrl-C进程退出
process.on("SIGINT", () => {
    process.exit(0);
});
