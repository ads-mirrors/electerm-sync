import { type AxiosInstance } from 'axios'
import { sign, type Algorithm } from 'jsonwebtoken'
import { type Config } from './types'

/**
 * Axios config may contain non-serializable objects such as
 * httpsAgent (SocksProxyAgent / HttpsProxyAgent) which have circular
 * references.  Instead of maintaining a fragile blacklist of known
 * problematic keys, we use a strict whitelist approach:
 *   - Keep primitive values (string / number / boolean) as-is.
 *   - Keep only the two core object keys — `headers` and `data` —
 *     round-tripped through JSON to strip any hidden non-serializable
 *     members.  If even those fail, skip the value entirely.
 *   - All other object / function / symbol values are ignored.
 * This guarantees the result is always JSON-serializable regardless
 * of what axios puts into the config.
 */
const CORE_OBJECT_KEYS = ['headers', 'data']

function sanitizeConfig (config: any): Config {
  if (config === null || config === undefined || typeof config !== 'object') {
    return config
  }
  const safe: Record<string, any> = {}
  for (const key of Object.keys(config)) {
    const value = config[key]
    const type = typeof value
    if (type === 'string' || type === 'number' || type === 'boolean') {
      safe[key] = value
    } else if (CORE_OBJECT_KEYS.includes(key) && value !== null && type === 'object') {
      try {
        safe[key] = JSON.parse(JSON.stringify(value))
      } catch {
        // Even a core object key may contain circular refs — skip it.
      }
    }
    // Skip all other object / function / symbol / undefined values.
  }
  return safe as Config
}

export class HTTPError extends Error {
  status: number
  statusText: string
  data: Object
  config: Config
  constructor (status: number, statusText: string, data: Object, config: Config) {
    super(`status: ${status}
statusText: ${statusText}
data: ${JSON.stringify(data, null, 2)}
config: ${JSON.stringify(sanitizeConfig(config), null, 2)}`)
    this.status = status
    this.statusText = statusText
    this.data = data
    this.config = sanitizeConfig(config)
  }
}

class ElectermSyncCore {
  algorithm: Algorithm
  token: string
  server: string
  userId: string
  _axios: AxiosInstance
  userAgentHeader: string
  type: string

  constructor (
    str: string,
    axiosInstance: AxiosInstance,
    type: string,
    userAgentHeader = 'electerm-sync/v2.0.0'
  ) {
    if (type === 'github') {
      this.token = str
      this.server = 'https://api.github.com'
      this.userId = ''
      this.algorithm = 'HS256'
    } else if (type === 'gitee') {
      this.token = str
      this.server = 'https://gitee.com/api/v5'
      this.userId = ''
      this.algorithm = 'HS256'
    } else {
      const [
        token,
        server,
        userId = '',
        algorithm = 'HS256'
      ] = str.split('####')
      this.token = token
      this.server = server
      this.userId = userId
      this.algorithm = algorithm as Algorithm
    }
    this.type = type
    this.userAgentHeader = userAgentHeader
    this._axios = axiosInstance

    // We do not monkey-patch _axios.request here to avoid mutating the user-provided instance permanently.
    // Instead, we handle errors in our local `request` wrapper.
  }

  async request (config: Config): Promise<any> {
    try {
      const res = await this._axios.request({
        ...config,
        headers: this._patchHeaders(config.headers)
      })
      return res.data
    } catch (e: any) {
      if (e.response !== undefined && e.response !== null) {
        throw new HTTPError(e.response.status, e.response.statusText, e.response.data, e.response.config)
      }
      // Sanitize non-serializable properties (e.g. httpsAgent) before re-throwing
      // so downstream JSON.stringify does not fail on circular references.
      if (e.config !== undefined && e.config !== null) {
        e.config = sanitizeConfig(e.config)
      }
      throw e
    }
  }

  async run (func: string, args: any[]): Promise<any> {
    if (this.type === 'github') {
      return await this._runGithub(func, args)
    } else if (this.type === 'gitee') {
      return await this._runGitee(func, args)
    } else {
      return await this._runCustomOrCloud(func, args)
    }
  }

  async _runGithub (func: string, args: any[]): Promise<any> {
    if (func === 'test') {
      return await this.request({
        url: `${this.server}/gists?per_page=1`,
        method: 'GET'
      })
    } else if (func === 'create') {
      const gistsData = args[0]
      return await this.request({
        url: `${this.server}/gists`,
        method: 'POST',
        data: gistsData
      })
    } else if (func === 'update') {
      const gistId = args[0]
      const gistsData = args[1]
      return await this.request({
        url: `${this.server}/gists/${gistId as string}`,
        method: 'PATCH',
        data: gistsData
      })
    } else if (func === 'getOne') {
      const gistId = args[0]
      return await this.request({
        url: `${this.server}/gists/${gistId as string}`,
        method: 'GET'
      })
    }
    throw new Error(`Unsupported func: ${func}`)
  }

  async _runGitee (func: string, args: any[]): Promise<any> {
    // Gitee uses ?access_token= for simplicity or Authorization header. We will use Authorization header as standard.
    if (func === 'test') {
      return await this.request({
        url: `${this.server}/gists?per_page=1`,
        method: 'GET'
      })
    } else if (func === 'create') {
      const gistsData = args[0]
      return await this.request({
        url: `${this.server}/gists`,
        method: 'POST',
        data: gistsData
      })
    } else if (func === 'update') {
      const gistId = args[0]
      const gistsData = args[1]
      return await this.request({
        url: `${this.server}/gists/${gistId as string}`,
        method: 'PATCH',
        data: gistsData
      })
    } else if (func === 'getOne') {
      const gistId = args[0]
      return await this.request({
        url: `${this.server}/gists/${gistId as string}`,
        method: 'GET'
      })
    }
    throw new Error(`Unsupported func: ${func}`)
  }

  async _runCustomOrCloud (func: string, args: any[]): Promise<any> {
    if (func === 'test') {
      if (args.length > 0) {
        this.userId = args[0]
      }
      return await this.request({
        url: this.server,
        method: 'POST'
      })
    } else if (func === 'create') {
      const data = args[0]
      return await this.request({
        url: this.server,
        method: 'PUT',
        data
      })
    } else if (func === 'update') {
      if (args.length > 1) {
        this.userId = args[0]
      }
      const data = args.length > 1 ? args[1] : args[0]
      return await this.request({
        url: this.server,
        method: 'PUT',
        data
      })
    } else if (func === 'getOne') {
      if (args.length > 0) {
        this.userId = args[0]
      }
      return await this.request({
        url: this.server,
        method: 'GET'
      })
    }
    throw new Error(`Unsupported func: ${func}`)
  }

  _patchHeaders (headers: any = {}): any {
    const auth = this._authHeader()
    return {
      'Content-Type': 'application/json',
      ...auth,
      'X-User-Agent': this.userAgentHeader,
      ...headers
    }
  }

  _authHeader (): Record<string, string> {
    if (this.type === 'github' || this.type === 'gitee') {
      return {
        Authorization: `token ${this.token}`
      }
    }
    const tk = this.userId !== ''
      ? sign({
        id: this.userId,
        exp: Date.now() + 1000000
      }, this.token, { algorithm: this.algorithm })
      : this.token

    return {
      Authorization: `Bearer ${tk}`
    }
  }
}

export async function electermSync (
  axiosInstance: AxiosInstance,
  type: string,
  func: string,
  args: any[],
  token: string
): Promise<any> {
  const syncCore = new ElectermSyncCore(token, axiosInstance, type)
  return await syncCore.run(func, args)
}
