// platform.js - platform detection and registry
window.__E2E_PLATFORM = (function() {
  const PLATFORMS = {};

  function register(name, module) {
    PLATFORMS[name] = module;
    module.name = name;
  }

  function detect() {
    const url = location.href;
    if (url.includes("web.bale.ai")) return "bale";
    if (url.includes("web.rubika.ir")) return "rubika";
    if (url.includes("web.eitaa.com")) return "eitaa";
    return null;
  }

  function getModule(name) {
    return PLATFORMS[name] || null;
  }

  return { register, detect, getModule };
})();
