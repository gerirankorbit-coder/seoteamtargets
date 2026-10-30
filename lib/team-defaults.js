// Default task list per member (by display name) as it was in code before V2, and the
// rule that turned it into a member's pre-V2 list. Shared by the server (Reset to
// Default, the one-time task-ID migration) and scripts/migration-dry-run.js.
'use strict';

const TEAM = {
  "Ali Lodhi": [
    { name: "Geo Fencing",       type: "layers",     label: "Layers" },
    { name: "GEO Tagging",       type: "count",      label: "Tagged" },
    { name: "Guest Posting",     type: "links",      label: "Links" },
    { name: "Reddit Accounts",   type: "count",      label: "Accounts" },
    { name: "Cloud Stacking",    type: "layers",     label: "Layers" },
    { name: "Pinterest Working", type: "links_note", label: "Links" },
    { name: "Web Working",       type: "note",       label: "Notes" },
  ],
  "Abida Khalid": [
    { name: "Web 2.0 Sites Building", type: "count",      label: "Sites" },
    { name: "Web 2.0 Blogs",          type: "links",      label: "Links" },
    { name: "Reddit",                 type: "links_note", label: "Links" },
    { name: "Geo Fencing",            type: "layers",     label: "Layers" },
  ],
  "Syed Salman Ali": [
    { name: "Citations",          type: "count",      label: "Citations" },
    { name: "PDF",                type: "links",      label: "Links" },
    { name: "Social Bookmarking", type: "links",      label: "Links" },
    { name: "Linktree",           type: "count_note", label: "Count" },
    { name: "Reddit Accounts",    type: "count",      label: "Accounts" },
  ],
  "Usman Tariq": [
    { name: "Web 2.0 Blogs",               type: "links", label: "Links" },
    { name: "Guest Posting",               type: "links", label: "Links" },
    { name: "Guest Posting Sites Finding", type: "count", label: "Sites" },
    { name: "Reddit Accounts",             type: "count", label: "Accounts" },
  ],
  "Abdullah Asif": [
    { name: "Guest Posting", type: "links", label: "Links" },
  ],
  "Abdullah Gull": [
    { name: "Video Submission",  type: "count",      label: "Videos" },
    { name: "Audio Submission",  type: "count",      label: "Files" },
    { name: "Google Properties", type: "count_note", label: "Count" },
    { name: "Google Stacking",   type: "layers",     label: "Layers" },
    { name: "Quora",             type: "links_note", label: "Links" },
    { name: "Image Submission",  type: "count",      label: "Images" },
    { name: "Reddit Accounts",   type: "count",      label: "Accounts" },
    { name: "Google Site Blogs", type: "links",      label: "Links" },
    { name: "Profiles",          type: "count",      label: "Profiles" },
  ],
  "Rizwan Haider": [
    { name: "Audio Submission",   type: "count", label: "Files" },
    { name: "Image Submission",   type: "count", label: "Images" },
    { name: "Profile Submission", type: "count", label: "Profiles" },
    { name: "Web 2.0 Blogs",      type: "links", label: "Links" },
  ],
  "Haseeb Ahmed": [
    { name: "GMBS",           type: "count",      label: "GMBs" },
    { name: "Blogs",          type: "links",      label: "Links" },
    { name: "Website Copies", type: "count_note", label: "Count" },
  ],
  "Sana Effat": [
    { name: "Blogs",           type: "links", label: "Links" },
    { name: "Website Content", type: "note",  label: "Notes" },
  ],
  "Muhammad Kashif": [
    { name: "Citations",       type: "count", label: "Citations" },
    { name: "Profile",         type: "count", label: "Profiles" },
    { name: "Reddit Accounts", type: "count", label: "Accounts" },
    { name: "PDF",             type: "links", label: "Links" },
  ],
  "Sajid Saleem": [
    { name: "Client Working Cross Check and Update", type: "note", label: "Notes" },
  ],
  "Toseef Ahmed": [
    { name: "GMB Posting",  type: "count",      label: "Posts" },
    { name: "GMB Designs",  type: "count",      label: "Designs" },
    { name: "GMB Audits",   type: "count_note", label: "Audits" },
    { name: "Pinterest",    type: "count",      label: "Pins" },
    { name: "BD/PD",        type: "note",       label: "Notes" },
  ],
  "Ahmad Rehman": [
    { name: "Console/Site Check",        type: "note",       label: "Notes" },
    { name: "Blogs Published",           type: "links",      label: "Links" },
    { name: "Keywords Tracking",         type: "count",      label: "Keywords" },
    { name: "Keywords Finding",          type: "count",      label: "Keywords" },
    { name: "Reddit Accounts",           type: "count",      label: "Accounts" },
    { name: "Technical Working Console", type: "note",       label: "Notes" },
    { name: "Links Inspections",         type: "count",      label: "Links" },
    { name: "Image Creation",            type: "count",      label: "Images" },
    { name: "Schema",                    type: "count_note", label: "Count" },
    { name: "Console Report",            type: "note",       label: "Notes" },
    { name: "GA4",                       type: "note",       label: "Notes" },
    { name: "GTM",                       type: "note",       label: "Notes" },
  ],
  "Naveed Liaqat": [
    { name: "Blogs Research",        type: "note",       label: "Notes" },
    { name: "Keywords for Websites", type: "count",      label: "Keywords" },
    { name: "Guest Posting",         type: "links",      label: "Links" },
    { name: "Reddit",                type: "links_note", label: "Links" },
    { name: "Blog Upload",           type: "count",      label: "Blogs" },
    { name: "Content Write Keywords Tracking", type: "count", label: "Keywords" },
  ],
  "Abler Khan": [
    { name: "Contextual Links",                 type: "links",      label: "Links" },
    { name: "Profiles",                         type: "count",      label: "Profiles" },
    { name: "Citations",                        type: "count",      label: "Citations" },
    { name: "Directories",                      type: "count",      label: "Dirs" },
    { name: "Multiple Sites CK for GP and PRs", type: "note",       label: "Notes" },
    { name: "Pinterest",                        type: "count",      label: "Pins" },
    { name: "Reddit Accounts",                  type: "count",      label: "Accounts" },
    { name: "Press Release",                    type: "links",      label: "Links" },
    { name: "Web 2.0",                          type: "links",      label: "Links" },
    { name: "Guest Post",                       type: "links",      label: "Links" },
    { name: "SBM",                              type: "count",      label: "Count" },
    { name: "Websites Reports",                 type: "note",       label: "Notes" },
  ],
  "Ali Raza": [
    { name: "Profiles",           type: "count",      label: "Profiles" },
    { name: "Guest Posting",      type: "links",      label: "Links" },
    { name: "Image Submission",   type: "count",      label: "Images" },
    { name: "PDF Submission",     type: "links",      label: "Links" },
    { name: "Social Bookmarking", type: "links",      label: "Links" },
    { name: "Reddit",             type: "links_note", label: "Links" },
    { name: "Sites Finding",      type: "count",      label: "Sites" },
    { name: "Pinterest",          type: "count",      label: "Pins" },
    { name: "Client Name",        type: "note",       label: "Clients" },
    { name: "Image Profile",      type: "count",      label: "Profiles" },
  ],
  "Ali Miraj Din": [
    { name: "Profile Creation", type: "count_note", label: "Profiles" },
    { name: "Local Citations",  type: "count_note", label: "Citations" },
    { name: "GEO Tagging",      type: "count",      label: "Tagged" },
    { name: "Quora",            type: "links_note", label: "Links" },
    { name: "Reddit",           type: "links_note", label: "Links" },
  ],
  "Muhammad Asim": [
    { name: "Profile Creations",   type: "count",      label: "Profiles" },
    { name: "Podcast Submission",  type: "count",      label: "Podcasts" },
    { name: "Image Submission",    type: "count",      label: "Images" },
    { name: "Video Submission",    type: "count",      label: "Videos" },
    { name: "Google Properties",   type: "count_note", label: "Count" },
    { name: "Google Site Blogs",   type: "links",      label: "Links" },
    { name: "Reddit Profile",      type: "count",      label: "Profiles" },
    { name: "Quora",               type: "links_note", label: "Links" },
    { name: "Google Sites",        type: "count",      label: "Sites" },
  ],
  "Anas Irfan": [
    { name: "GMB Guest Posting", type: "count", label: "Posts" },
    { name: "Keyword Research",  type: "count", label: "Keywords" },
    { name: "Reddit Profile",    type: "count", label: "Profiles" },
  ],
  "Mazhar": [
    { name: "Blogs Uploading",   type: "links",      label: "Links" },
    { name: "On Page Technical", type: "note",       label: "Notes" },
    { name: "Web 2.0 Blogs",     type: "links",      label: "Links" },
    { name: "Reddit",            type: "links_note", label: "Links" },
  ],
  "Anas Raza": [
    { name: "Profiles",           type: "count",      label: "Profiles" },
    { name: "Video Submission",   type: "count",      label: "Videos" },
    { name: "Podcast Submission", type: "count",      label: "Podcasts" },
    { name: "Image Submission",   type: "count",      label: "Images" },
    { name: "Reddit Profile",     type: "count",      label: "Profiles" },
    { name: "Quora",              type: "links_note", label: "Links" },
  ],
  "Atif Ahmad": [
    { name: "Quora",          type: "links_note", label: "Links" },
    { name: "Profile",        type: "count",      label: "Profiles" },
    { name: "Citations",      type: "count",      label: "Citations" },
    { name: "Reddit Profile", type: "count",      label: "Profiles" },
  ],
};

// Pre-V2 task list of a member (used only by the migration): a manager-saved override
// wins, plus TEAM tasks added in code after that override was saved.
// overrides / baselines are the Config values "taskOverrides" / "taskBaselines".
function legacyListFor(overrides = {}, baselines = {}) {
  return function legacyMemberTasks(displayName) {
    const defaults = TEAM[displayName] || [];
    const override = overrides[displayName];
    if (!override) return defaults;
    const have     = new Set(override.map(t => t.name));
    const baseline = new Set(baselines[displayName] || []);
    const added    = defaults.filter(t => !have.has(t.name) && !baseline.has(t.name));
    return added.length ? [...override, ...added] : override;
  };
}

module.exports = { TEAM, legacyListFor };
