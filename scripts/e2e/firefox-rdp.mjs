// System Firefox harness. Uses the RDP client already installed through WXT.
// Every run gets a disposable profile and rejects non-loopback HTTP(S) traffic.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const wxtRequire = createRequire(require.resolve('wxt'));
const webExtPath = wxtRequire.resolve('web-ext-run');
const { default: webExt } = await import(pathToFileURL(webExtPath).href);

export async function launchFirefox(sourceDir) {
  const rejectedRequests = [];
  const deny = createServer((request, response) => {
    rejectedRequests.push(request.url);
    response.writeHead(502);
    response.end('External traffic disabled in local integration tests');
  });
  deny.on('connect', (request, socket) => {
    rejectedRequests.push(request.url);
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise((resolveListen) => deny.listen(0, '127.0.0.1', resolveListen));
  const port = deny.address().port;
  let runner;
  try {
    runner = await webExt.cmd.run({
      sourceDir: resolve(sourceDir),
      firefox: process.env.SI_FIREFOX_BINARY || '/usr/bin/firefox',
      target: ['firefox-desktop'],
      args: ['--headless'],
      noInput: true,
      noReload: true,
      startUrl: 'about:blank',
      pref: {
        'network.proxy.type': 1,
        'network.proxy.http': '127.0.0.1',
        'network.proxy.http_port': port,
        'network.proxy.ssl': '127.0.0.1',
        'network.proxy.ssl_port': port,
        'network.proxy.no_proxies_on': 'localhost,127.0.0.1',
        'network.proxy.failover_direct': false,
        'network.trr.mode': 5,
        'network.dns.disablePrefetch': true,
        'network.prefetch-next': false,
        'browser.safebrowsing.downloads.enabled': false,
        'app.update.auto': false,
        'extensions.update.enabled': false,
      },
    });
    const desktop = runner.extensionRunners[0];
    const remote = desktop.remoteFirefox;
    // web-ext-run's small RDP client knows installation events only. Preserve
    // its request handling while routing modern watcher/evaluation events.
    const handleMessage = remote.client._handleMessage.bind(remote.client);
    remote.client._handleMessage = (packet) => {
      if (['target-available-form', 'target-destroyed-form', 'evaluationResult',
        'resources-available-array', 'resources-updated-array',
        'resources-destroyed-array'].includes(packet.type)) {
        remote.client.emit('protocol-event', packet);
        return;
      }
      handleMessage(packet);
    };
    const addonId = desktop.reloadableExtensions.get(resolve(sourceDir));
    return {
      remote,
      addonId,
      rejectedRequests,
      async close() {
        remote.disconnect();
        await runner.exit();
        deny.closeAllConnections();
        await new Promise((close) => deny.close(close));
      },
    };
  } catch (error) {
    if (runner) await runner.exit();
    deny.closeAllConnections();
    await new Promise((close) => deny.close(close));
    throw error;
  }
}

export async function watchExtension(harness) {
  const addon = await harness.remote.getInstalledAddon(harness.addonId);
  const watcher = await harness.remote.client.request({ to: addon.actor, type: 'getWatcher' });
  const targets = new Map();
  harness.remote.client.on('protocol-event', (packet) => {
    if (packet.from !== watcher.actor) return;
    if (packet.type === 'target-available-form') targets.set(packet.target.actor, packet.target);
    if (packet.type === 'target-destroyed-form') targets.delete(packet.target.actor);
  });
  await harness.remote.client.request({ to: watcher.actor, type: 'watchTargets', targetType: 'frame' });
  return targets;
}

export async function waitForTarget(targets, predicate, timeout = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const target = [...targets.values()].find(predicate);
    if (target) return target;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('Firefox target did not appear before timeout');
}

export async function tabTarget(harness, url, timeout = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const { tabs } = await harness.remote.client.request('listTabs');
    const tab = tabs.find((item) => item.url === url);
    if (tab) {
      const { frame } = await harness.remote.client.request({ to: tab.actor, type: 'getTarget' });
      return frame;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('Firefox tab did not appear before timeout');
}

export async function nativePaste(harness, text) {
  const { processDescriptor } = await harness.remote.client.request({ to: 'root', type: 'getProcess', id: 0 });
  const { process: target } = await harness.remote.client.request({ to: processDescriptor.actor, type: 'getTarget' });
  // Use Firefox's real clipboard command: fabricated ClipboardEvents are
  // deliberately rejected by the extension's trusted-event guard.
  await evaluate(harness, target, `
    const win = Services.wm.getMostRecentWindow('navigator:browser');
    const helper = Components.classes['@mozilla.org/widget/clipboardhelper;1'].getService(Components.interfaces.nsIClipboardHelper);
    helper.copyString(${JSON.stringify(text)});
    win.goDoCommand('cmd_paste');
    return true;
  `);
}

export async function evaluate(harness, target, source, timeout = 10_000) {
  const client = harness.remote.client;
  let onEvent;
  let timer;
  let resultId;
  const earlyResults = [];
  const result = new Promise((resolveResult, reject) => {
    timer = setTimeout(() => reject(new Error('Firefox evaluation timed out')), timeout);
    onEvent = (packet) => {
      if (packet.from !== target.consoleActor || packet.type !== 'evaluationResult') return;
      if (!resultId) {
        earlyResults.push(packet);
        return;
      }
      if (packet.resultID !== resultId) return;
      if (packet.hasException || packet.exceptionMessage || packet.topLevelAwaitRejected) {
        reject(new Error(packet.exceptionMessage || 'Firefox evaluation failed'));
      } else {
        resolveResult(packet.result);
      }
    };
    client.on('protocol-event', onEvent);
  });
  // A transport failure can happen before this promise is awaited.
  result.catch(() => {});
  try {
    // This is the same await mapping used by Firefox's console frontend.
    const response = await client.request({
      to: target.consoleActor,
      type: 'evaluateJSAsync',
      text: `(async () => JSON.stringify(await (async () => { ${source} })()))()`,
      mapped: { await: true },
    });
    resultId = response.resultID;
    for (const packet of earlyResults) onEvent(packet);
    let value = await result;
    if (value?.type === 'longString' && value.length <= 1024 * 1024) {
      const response = await client.request({ to: value.actor, type: 'substring', start: 0, end: value.length });
      value = response.substring;
    }
    if (typeof value !== 'string') throw new Error('Firefox evaluation did not return JSON');
    return JSON.parse(value);
  } finally {
    clearTimeout(timer);
    client.off('protocol-event', onEvent);
  }
}
