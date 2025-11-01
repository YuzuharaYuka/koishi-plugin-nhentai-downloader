// src/commands/index.ts
import { Context, Session } from 'koishi'
import { Command } from 'koishi'
import { Config } from '../config'
import { ApiService } from '../services/api'
import { NhentaiService } from '../services/nhentai'
import { registerSearchCommands } from './search'
import { registerDownloadCommands } from './download'
import { registerRandomCommands } from './random'

/**
 * 注册所有指令
 */
export function registerAllCommands(
  ctx: Context,
  config: Config,
  apiService: ApiService,
  nhentaiService: NhentaiService,
  ensureInitialized: (session: Session) => boolean
): void {
  // 先注册搜索指令（返回主命令）
  const nhCmd = registerSearchCommands(ctx, config, apiService, nhentaiService, ensureInitialized)

  // 注册下载指令（使用主命令）
  registerDownloadCommands(ctx, config, nhentaiService, ensureInitialized, nhCmd)

  // 注册随机和热门指令（使用主命令）
  registerRandomCommands(ctx, config, nhentaiService, ensureInitialized, nhCmd)
}

