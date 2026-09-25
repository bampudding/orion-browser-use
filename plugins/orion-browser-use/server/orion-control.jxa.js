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
  if (request.operation === "page.locator") return locator(app, request);
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

function locator(app, request) {
  if (typeof request.selector !== "string" || request.selector.length > 2000) throw new Error("Invalid CSS selector.");
  var target = activeTab(app, request.ref);
  var selector = JSON.stringify(request.selector);
  var action = request.action;
  var value = JSON.stringify(request.value);
  var script = "(function(){var matches=Array.from(document.querySelectorAll(" + selector + "));var action=" + JSON.stringify(action) + ";if(action==='count')return {count:matches.length};if(action==='text')return {text:matches.map(function(e){return (e.innerText||e.textContent||'').trim()}).join('\\n').slice(0,12000)};if(action==='waitFor'){var o=" + value + ";function visible(e){var s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0}var found=matches.length>0,shown=found&&matches.some(visible),ok=o.state==='attached'?found:o.state==='visible'?shown:o.state==='hidden'?!shown:!found;return {ready:ok,state:o.state}}if(matches.length!==1)throw new Error('Expected one element for selector; found '+matches.length+'. Inspect the page and use a more specific selector.');var e=matches[0];if(action==='click'){if(e.disabled||e.getAttribute('aria-disabled')==='true')throw new Error('Element is disabled.');e.scrollIntoView({block:'center',inline:'center'});e.click();return {clicked:true}}if(action==='fill'){if(!('value'in e)&&!e.isContentEditable)throw new Error('Element is not editable.');e.focus();if(e.isContentEditable)e.textContent=" + value + ";else{var proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;var d=Object.getOwnPropertyDescriptor(proto,'value');if(d&&d.set)d.set.call(e," + value + ");else e.value=" + value + ";}e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return {filled:true,value:e.isContentEditable?e.textContent:e.value}}if(action==='check'){if(e.type!=='checkbox'&&e.type!=='radio')throw new Error('Element is not a checkbox or radio input.');e.checked=!!" + value + ";e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return {checked:e.checked}}if(action==='selectOption'){if(e.tagName!=='SELECT')throw new Error('Element is not a select.');e.value=" + value + ";e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return {value:e.value}}if(action==='scrollIntoView'){e.scrollIntoView({block:'center',inline:'center'});return {scrolled:true}}throw new Error('Unknown locator action: '+action)})()";
  if (action === "waitFor") {
    var deadline = Date.now() + Number(request.value.timeout || 0);
    while (true) {
      var state = runPageJson(app, script, request.ref);
      if (state && state.ready) return state;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for selector to become " + request.value.state + ".");
      pauseForOrion(150);
    }
  }
  var deadline = Date.now() + 10000;
  while (true) {
    var rawResult = runPageJson(app, script, request.ref);
    if (rawResult != null) return rawResult;
    if (Date.now() >= deadline) throw new Error("The page is still loading; locator operation timed out.");
    pauseForOrion(150);
  }
}

function runPageJson(app, code, ref) {
  var target = activeTab(app, ref);
  var wrapped = "(function(){try{var value=(0,eval)(" + JSON.stringify(code) + ");if(value===undefined)return JSON.stringify({type:'undefined'});return JSON.stringify({type:'value',value:value})}catch(error){return JSON.stringify({type:'error',error:String(error&&error.message||error)})}})()";
  var raw = app.doJavaScript(wrapped, { in: target });
  if (raw == null) return null;
  var result = parsePageJson(raw);
  if (result && result.type === "error") throw new Error(result.error);
  return result && result.type === "value" ? result.value : null;
}

function pauseForOrion(milliseconds) {
  ObjC.import("Foundation");
  $.NSThread.sleepForTimeInterval(milliseconds / 1000);
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
