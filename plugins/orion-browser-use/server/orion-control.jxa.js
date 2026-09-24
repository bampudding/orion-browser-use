function run(argv) {
  var request;
  try {
    request = JSON.parse(argv[0] || "{}");
    var app = Application("Orion");
    var result = dispatch(app, request);
    return JSON.stringify({ ok: true, value: result });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

function dispatch(app, request) {
  if (request.operation === "doctor") {
    var windows = app.windows();
    var javascriptAvailable = false;
    if (windows.length > 0) {
      try {
        var active = activeTab(app, null);
        javascriptAvailable = Number(app.doJavaScript("1 + 1", { in: active })) === 2;
      } catch (error) {
        javascriptAvailable = false;
      }
    }
    return {
      browser: "Orion",
      version: app.version(),
      running: true,
      frontmost: app.frontmost(),
      windowCount: windows.length,
      javascriptFromAppleEvents: javascriptAvailable,
      issues: javascriptAvailable || windows.length === 0 ? [] : ["Orion is running, but page JavaScript through Apple Events could not be verified."]
    };
  }

  if (request.operation === "tabs.list") return listTabs(app);
  if (request.operation === "tabs.active") return describeActiveTab(app);
  if (request.operation === "tabs.open") return openTab(app, request.url);
  if (request.operation === "tabs.activate") return activateTab(app, request.ref);
  if (request.operation === "tabs.close") return closeTab(app, request.ref);
  if (request.operation === "tabs.navigate") return navigateTab(app, request.url, request.ref);
  if (request.operation === "page.snapshot") return snapshot(app, request.ref);
  if (request.operation === "page.evaluate") return evaluatePage(app, request.code, request.ref);
  throw new Error("unknown_orion_operation: " + request.operation);
}

function listTabs(app) {
  var windows = app.windows();
  var result = [];
  for (var windowIndex = 0; windowIndex < windows.length; windowIndex++) {
    var window = windows[windowIndex];
    var tabs = window.tabs();
    var current = window.currentTab();
    var currentUrl = safeTabUrl(current);
    var currentTitle = safeTabTitle(current);
    for (var tabIndex = 0; tabIndex < tabs.length; tabIndex++) {
      var tab = tabs[tabIndex];
      var url = safeTabUrl(tab);
      var title = safeTabTitle(tab);
      result.push({
        windowIndex: windowIndex + 1,
        tabIndex: tabIndex + 1,
        title: title,
        url: url,
        active: url === currentUrl && title === currentTitle
      });
    }
  }
  return result;
}

function activeTab(app, ref) {
  var target = ref ? getTab(app, ref) : null;
  if (target) return target.tab;
  var windows = app.windows();
  if (!windows.length) throw new Error("Orion has no open windows.");
  return windows[0].currentTab();
}

function describeActiveTab(app) {
  var windows = app.windows();
  if (!windows.length) throw new Error("Orion has no open windows.");
  var tab = windows[0].currentTab();
  return {
    windowIndex: 1,
    tabIndex: currentTabIndex(windows[0]),
    title: safeTabTitle(tab),
    url: safeTabUrl(tab),
    active: true
  };
}

function currentTabIndex(window) {
  var current = window.currentTab();
  var tabs = window.tabs();
  var currentUrl = safeTabUrl(current);
  var currentTitle = safeTabTitle(current);
  for (var i = 0; i < tabs.length; i++) {
    if (safeTabUrl(tabs[i]) === currentUrl && safeTabTitle(tabs[i]) === currentTitle) return i + 1;
  }
  return 1;
}

function openTab(app, url) {
  validateHttpUrl(url);
  var windows = app.windows();
  if (!windows.length) throw new Error("Orion has no open window to attach a task tab to.");
  var targetWindow = windows[0];
  var before = targetWindow.tabs().length;
  app.make({ new: "tab", at: targetWindow, withProperties: { url: url } });
  var afterTabs = targetWindow.tabs();
  if (afterTabs.length <= before) throw new Error("Orion did not create a new tab.");
  var created = afterTabs[afterTabs.length - 1];
  return {
    windowIndex: 1,
    tabIndex: afterTabs.length,
    title: safeTabTitle(created),
    url: safeTabUrl(created),
    active: true
  };
}

function activateTab(app, ref) {
  var target = getTab(app, ref);
  target.window.currentTab = target.tab;
  return {
    windowIndex: target.windowIndex,
    tabIndex: target.tabIndex,
    title: safeTabTitle(target.tab),
    url: safeTabUrl(target.tab),
    active: true
  };
}

function closeTab(app, ref) {
  var target = getTab(app, ref);
  var descriptor = {
    windowIndex: target.windowIndex,
    tabIndex: target.tabIndex,
    title: safeTabTitle(target.tab),
    url: safeTabUrl(target.tab)
  };
  target.tab.close();
  return { closed: true, tab: descriptor };
}

function navigateTab(app, url, ref) {
  validateHttpUrl(url);
  var target = activeTab(app, ref);
  var code = "location.assign(" + JSON.stringify(url) + "); 'navigation requested'";
  app.doJavaScript(code, { in: target });
  return { navigationRequested: true, url: url };
}

function snapshot(app, ref) {
  var target = activeTab(app, ref);
  var code = "JSON.stringify({title:document.title,url:location.href,text:(document.body&&document.body.innerText||'').slice(0,24000),controls:Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role=button],[role=link]')).slice(0,200).map(function(el,index){return {index:index,tag:el.tagName.toLowerCase(),role:el.getAttribute('role')||'',text:(el.innerText||el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.value||'').trim().slice(0,240),href:el.href||'',disabled:!!el.disabled}})})";
  return parsePageJson(app.doJavaScript(code, { in: target }));
}

function evaluatePage(app, code, ref) {
  if (typeof code !== "string" || code.length > 100000) throw new Error("page JavaScript must be a string up to 100000 characters.");
  var target = activeTab(app, ref);
  var wrapped = "(function(){var value=(0,eval)(" + JSON.stringify(code) + ");if(value===undefined)return JSON.stringify({type:'undefined'});try{return JSON.stringify({type:'value',value:value})}catch(error){return JSON.stringify({type:typeof value,value:String(value),serializationError:String(error)})}})()";
  return parsePageJson(app.doJavaScript(wrapped, { in: target }));
}

function parsePageJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); }
  catch (error) { return { text: value }; }
}

function getTab(app, ref) {
  var windowIndex = Number(ref && ref.windowIndex);
  var tabIndex = Number(ref && ref.tabIndex);
  if (!Number.isInteger(windowIndex) || !Number.isInteger(tabIndex) || windowIndex < 1 || tabIndex < 1) {
    throw new Error("tab reference requires positive windowIndex and tabIndex values.");
  }
  var windows = app.windows();
  if (windowIndex > windows.length) throw new Error("Orion window reference is stale.");
  var window = windows[windowIndex - 1];
  var tabs = window.tabs();
  if (tabIndex > tabs.length) throw new Error("Orion tab reference is stale.");
  return { window: window, tab: tabs[tabIndex - 1], windowIndex: windowIndex, tabIndex: tabIndex };
}

function safeTabTitle(tab) {
  try { return String(tab.name() || ""); }
  catch (error) { return ""; }
}

function safeTabUrl(tab) {
  try { return String(tab.url() || ""); }
  catch (error) { return ""; }
}

function validateHttpUrl(url) {
  if (typeof url !== "string") throw new Error("url must be a string.");
  var match = /^(https?):\/\//i.exec(url);
  if (!match) throw new Error("Only absolute http and https URLs are supported.");
}
