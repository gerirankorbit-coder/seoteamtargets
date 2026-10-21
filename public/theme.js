/* Theme toggle (light / dark), remembered per user in localStorage.
 *
 * Every page sets <html data-theme> in a tiny inline <head> script before the
 * stylesheets load, so the saved theme is used from the first paint (no flash):
 *
 *   ro_theme              theme last used on this device
 *   ro_theme_user         username last signed in on this device
 *   ro_theme:<username>   that user's saved theme
 *
 * This file wires every [data-theme-toggle] button and exposes window.roTheme:
 *   roTheme.setUser(username)  call once the page knows who is signed in
 *   roTheme.set('light'|'dark'), roTheme.get()
 * A 'ro-theme-change' event fires on document after each change.
 */
(function () {
  var root = document.documentElement;
  function read(k)     { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function write(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function valid(t)    { return t === 'light' || t === 'dark'; }

  function get() { return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }

  function apply(theme) {
    if (!valid(theme) || theme === get()) return;
    root.setAttribute('data-theme', theme);
    document.querySelectorAll('[data-theme-toggle]').forEach(label);
    document.dispatchEvent(new CustomEvent('ro-theme-change', { detail: { theme: theme } }));
  }

  function set(theme) {
    if (!valid(theme)) return;
    write('ro_theme', theme);
    var user = read('ro_theme_user');
    if (user) write('ro_theme:' + user, theme);
    apply(theme);
  }

  function setUser(username) {
    if (!username) return;
    write('ro_theme_user', username);
    var saved = read('ro_theme:' + username);
    if (valid(saved)) { write('ro_theme', saved); apply(saved); }
    else write('ro_theme:' + username, get());
  }

  function label(btn) {
    var next = get() === 'dark' ? 'light' : 'dark';
    btn.setAttribute('aria-label', 'Switch to ' + next + ' theme');
    btn.setAttribute('title', 'Switch to ' + next + ' theme');
  }

  function wire() {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      if (btn.dataset.themeWired) return;
      btn.dataset.themeWired = '1';
      label(btn);
      btn.addEventListener('click', function () { set(get() === 'dark' ? 'light' : 'dark'); });
    });
  }

  window.roTheme = { get: get, set: set, setUser: setUser };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
