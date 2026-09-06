function createEvent() {
  const listeners = new Set()
  return {
    addListener(fn) {
      listeners.add(fn)
    },
    removeListener(fn) {
      listeners.delete(fn)
    },
    hasListener(fn) {
      return listeners.has(fn)
    },
    _listeners: listeners,
    _reset() {
      listeners.clear()
    }
  }
}

function createStorageArea(ns, recordCall) {
  let store = {}
  return {
    async get(keys) {
      recordCall(`${ns}.get`, [keys])
      if (keys === null || keys === undefined) {
        return { ...store }
      }
      if (typeof keys === 'string') {
        const res = {}
        if (keys in store) {
          res[keys] = store[keys]
        }
        return res
      }
      if (Array.isArray(keys)) {
        const res = {}
        for (const k of keys) {
          if (k in store) {
            res[k] = store[k]
          }
        }
        return res
      }
      if (typeof keys === 'object') {
        const res = {}
        for (const [k, v] of Object.entries(keys)) {
          res[k] = k in store ? store[k] : v
        }
        return res
      }
      return { ...store }
    },
    async set(items) {
      recordCall(`${ns}.set`, [items])
      if (items && typeof items === 'object') {
        Object.assign(store, items)
      }
    },
    async remove(keys) {
      recordCall(`${ns}.remove`, [keys])
      const arr = Array.isArray(keys) ? keys : [keys]
      for (const k of arr) {
        delete store[k]
      }
    },
    async clear() {
      recordCall(`${ns}.clear`, [])
      store = {}
    },
    _reset() {
      store = {}
    }
  }
}

function buildChromeMock() {
  const calls = []

  function recordCall(api, args) {
    calls.push({ api, args })
  }

  const localStorage = createStorageArea('storage.local', recordCall)
  const sessionStorage = createStorageArea('storage.session', recordCall)

  const alarmsMap = new Map()
  const onAlarm = createEvent()

  let nextTabId = 1
  const tabsMap = new Map()

  const onMessage = createEvent()
  const onStartup = createEvent()
  const onInstalled = createEvent()

  const actionOnClicked = createEvent()
  const contextMenusOnClicked = createEvent()
  const notificationsOnButtonClicked = createEvent()
  const notificationsOnClicked = createEvent()

  let nextDownloadId = 1
  let nextWindowId = 1
  const windowsMap = new Map()
  let defaultTabStatus = 'complete'
  let tabResponder = () => undefined

  const mock = {
    __calls: calls,

    storage: {
      local: localStorage,
      session: sessionStorage
    },

    alarms: {
      async create(name, alarmInfo) {
        recordCall('alarms.create', [name, alarmInfo])
        alarmsMap.set(name, {
          name,
          scheduledTime: alarmInfo?.when !== undefined ? alarmInfo.when : Date.now(),
          periodInMinutes: alarmInfo?.periodInMinutes
        })
      },
      async get(name) {
        recordCall('alarms.get', [name])
        return alarmsMap.get(name)
      },
      async getAll() {
        recordCall('alarms.getAll', [])
        return Array.from(alarmsMap.values())
      },
      async clear(name) {
        recordCall('alarms.clear', [name])
        return alarmsMap.delete(name)
      },
      async clearAll() {
        recordCall('alarms.clearAll', [])
        alarmsMap.clear()
        return true
      },
      onAlarm
    },

    tabs: {
      async create(props = {}) {
        recordCall('tabs.create', [props])
        const tab = {
          id: nextTabId++,
          url: props.url || '',
          active: props.active !== undefined ? props.active : true,
          status: defaultTabStatus,
          discarded: false,
          ...props
        }
        tabsMap.set(tab.id, tab)
        // 讓測試模擬「開啟後被伺服器轉址」（例如沒登入就被導到登入頁）
        if (typeof mock.__onTabCreated === 'function') mock.__onTabCreated(tab)
        return tab
      },
      async query(queryInfo = {}) {
        recordCall('tabs.query', [queryInfo])
        return Array.from(tabsMap.values()).filter((t) => {
          if (queryInfo.url !== undefined && t.url !== queryInfo.url) return false
          if (queryInfo.active !== undefined && t.active !== queryInfo.active) return false
          return true
        })
      },
      async remove(tabIds) {
        recordCall('tabs.remove', [tabIds])
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        for (const id of ids) {
          tabsMap.delete(id)
        }
      },
      async get(tabId) {
        recordCall('tabs.get', [tabId])
        return tabsMap.get(tabId)
      },
      async reload(tabId) {
        recordCall('tabs.reload', [tabId])
        const tab = tabsMap.get(tabId)
        if (tab) {
          tab.discarded = false
          tab.status = defaultTabStatus
        }
      },
      async sendMessage(tabId, msg) {
        recordCall('tabs.sendMessage', [tabId, msg])
        return tabResponder(tabId, msg)
      },
      async update(tabId, updateProps = {}) {
        recordCall('tabs.update', [tabId, updateProps])
        const tab = tabsMap.get(tabId)
        if (tab) {
          Object.assign(tab, updateProps)
        }
        return tab
      }
    },

    action: {
      async setBadgeText(details) {
        recordCall('action.setBadgeText', [details])
      },
      async setBadgeBackgroundColor(details) {
        recordCall('action.setBadgeBackgroundColor', [details])
      },
      async setTitle(details) {
        recordCall('action.setTitle', [details])
      },
      async setIcon(details) {
        recordCall('action.setIcon', [details])
      },
      onClicked: actionOnClicked
    },

    notifications: {
      async create(...args) {
        recordCall('notifications.create', args)
        return args[0]
      },
      async clear(...args) {
        recordCall('notifications.clear', args)
        return true
      },
      onButtonClicked: notificationsOnButtonClicked,
      onClicked: notificationsOnClicked
    },

    contextMenus: {
      async create(...args) {
        recordCall('contextMenus.create', args)
        const cb = args.find((a) => typeof a === 'function')
        if (cb) cb()
        return typeof args[0] === 'object' ? args[0]?.id : args[0]
      },
      async update(...args) {
        recordCall('contextMenus.update', args)
        const cb = args.find((a) => typeof a === 'function')
        if (cb) cb()
      },
      async remove(...args) {
        recordCall('contextMenus.remove', args)
        const cb = args.find((a) => typeof a === 'function')
        if (cb) cb()
      },
      async removeAll(...args) {
        recordCall('contextMenus.removeAll', args)
        const cb = args.find((a) => typeof a === 'function')
        if (cb) cb()
      },
      onClicked: contextMenusOnClicked
    },

    runtime: {
      async getPlatformInfo() {
        recordCall('runtime.getPlatformInfo', [])
        return { os: 'mac', arch: 'arm64' }
      },
      async getURL(path) {
        recordCall('runtime.getURL', [path])
        return `chrome-extension://autofetcher/${path}`
      },
      async sendMessage(message) {
        recordCall('runtime.sendMessage', [message])
      },
      onMessage,
      onStartup,
      onInstalled
    },

    scripting: {
      async executeScript(...args) {
        recordCall('scripting.executeScript', args)
        return []
      },
      async insertCSS(...args) {
        recordCall('scripting.insertCSS', args)
      },
      async removeCSS(...args) {
        recordCall('scripting.removeCSS', args)
      }
    },

    downloads: {
      async download(...args) {
        recordCall('downloads.download', args)
        return nextDownloadId++
      }
    },

    windows: {
      async create(createData = {}) {
        recordCall('windows.create', [createData])
        const win = { id: nextWindowId++, ...createData }
        windowsMap.set(win.id, win)
        return win
      },
      async get(windowId, queryOptions) {
        recordCall('windows.get', [windowId, queryOptions])
        return windowsMap.get(windowId)
      },
      async getAll(queryOptions) {
        recordCall('windows.getAll', [queryOptions])
        return Array.from(windowsMap.values())
      },
      async remove(windowId) {
        recordCall('windows.remove', [windowId])
        windowsMap.delete(windowId)
      },
      async update(windowId, updateInfo = {}) {
        recordCall('windows.update', [windowId, updateInfo])
        const win = windowsMap.get(windowId)
        if (win) {
          Object.assign(win, updateInfo)
        }
        return win
      }
    },

    async __emitMessage(msg, sender = {}) {
      return new Promise((resolve) => {
        let isAsync = false
        let resolved = false
        const sendResponse = (res) => {
          if (!resolved) {
            resolved = true
            resolve(res)
          }
        }
        for (const fn of onMessage._listeners) {
          const ret = fn(msg, sender, sendResponse)
          if (ret === true) {
            isAsync = true
          } else if (ret && typeof ret.then === 'function') {
            isAsync = true
            ret.then(sendResponse)
          }
        }
        if (!isAsync && !resolved) {
          resolve(undefined)
        }
      })
    },

    async __emitStartup() {
      for (const fn of onStartup._listeners) {
        await fn()
      }
    },

    async __emitInstalled(details = {}) {
      for (const fn of onInstalled._listeners) {
        await fn(details)
      }
    },

    async __emitAlarm(name) {
      const alarm = typeof name === 'string' ? { name } : name
      for (const fn of onAlarm._listeners) {
        await fn(alarm)
      }
    },

    async __emitContextMenuClick(info, tab) {
      for (const fn of contextMenusOnClicked._listeners) await fn(info, tab)
    },
    async __emitNotificationButton(notificationId, buttonIndex) {
      for (const fn of notificationsOnButtonClicked._listeners) await fn(notificationId, buttonIndex)
    },

    __onTabCreated: null,
    __setTabResponder(fn) {
      tabResponder = fn
    },
    __setTabState(tabId, patch) {
      const tab = tabsMap.get(tabId)
      if (tab) Object.assign(tab, patch)
    },
    __setDefaultTabStatus(status) {
      defaultTabStatus = status
    },
    __setWindows(list) {
      windowsMap.clear()
      for (const w of list) windowsMap.set(w.id, w)
    },

    _resetAll() {
      calls.length = 0
      defaultTabStatus = 'complete'
      tabResponder = () => undefined
      localStorage._reset()
      sessionStorage._reset()
      alarmsMap.clear()
      onAlarm._reset()
      tabsMap.clear()
      nextTabId = 1
      actionOnClicked._reset()
      onMessage._reset()
      onStartup._reset()
      onInstalled._reset()
      nextDownloadId = 1
      contextMenusOnClicked._reset()
      notificationsOnButtonClicked._reset()
      notificationsOnClicked._reset()
      windowsMap.clear()
      nextWindowId = 1
      windowsMap.set(1, { id: 1, state: 'normal' })
    }
  }

  return mock
}

let currentMock = null

export function installChromeMock() {
  if (!currentMock) {
    currentMock = buildChromeMock()
  }
  globalThis.chrome = currentMock
  return currentMock
}

export function resetChromeMock() {
  if (!currentMock) {
    currentMock = buildChromeMock()
  }
  currentMock._resetAll()
  globalThis.chrome = currentMock
}
