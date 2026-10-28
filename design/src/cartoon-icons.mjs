/** 游戏图标使用显式填充与轮廓，避免宿主按钮的文字色覆盖插画。 */
export const cartoonIcons = {
  coin: `<g stroke="#a65b0c" stroke-width="2.6" stroke-linejoin="round">
    <ellipse cx="25" cy="26" rx="18" ry="18" fill="#dd8b13"/>
    <circle cx="22" cy="22" r="18" fill="#ffca33"/>
    <circle cx="22" cy="22" r="13.3" fill="#ffdf64" stroke="#e4a020" stroke-width="2"/>
    <path d="m22 12 3 6 6.6 1-4.8 4.7 1.1 6.6-5.9-3.1-5.9 3.1 1.1-6.6-4.8-4.7 6.6-1Z" fill="#efac20" stroke="#c48517" stroke-width="1.7"/>
    <path d="M11 16a13 13 0 0 1 7-6" fill="none" stroke="#fff6b5" stroke-width="3.7" stroke-linecap="round"/>
    <path d="m35 34 1 4m-8 0v4" fill="none" stroke="#a65b0c" stroke-width="2"/>
  </g>`,
  gem: `<g stroke="#236b9c" stroke-width="2.6" stroke-linejoin="round">
    <path d="m5 17 9-11h20l9 11-19 25Z" fill="#3eb9ef"/>
    <path d="m5 17 13 1L14 6Zm13 1L24 6l6 12Zm12 0 13-1L34 6Z" fill="#a9eeff" stroke="#369bd1" stroke-width="1.7"/>
    <path d="m14 6 4 12L24 6m0 0 6 12 4-12" fill="#64d4fa" stroke="#369bd1" stroke-width="1.7"/>
    <path d="m5 17 19 25-6-24m25-1L24 42l6-24" fill="#269bdd" stroke="#237db5" stroke-width="1.7"/>
    <path d="m18 18 6 24 6-24Z" fill="#66d9fb" stroke="#329bcd" stroke-width="1.7"/>
    <path d="m5 17 9-11h20l9 11-19 25Z" fill="none"/>
    <path d="m16 10-4 5m9-5 3-2" fill="none" stroke="#e3fbff" stroke-width="3" stroke-linecap="round"/>
  </g>`,
  book: `<g stroke="#397d74" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 9c8-3 13-1 19 3 6-4 11-6 19-3v30c-8-3-14-2-19 2-5-4-11-5-19-2Z" fill="#55b49a"/>
    <path d="M8 6c6-1 11 1 16 5 5-4 10-6 16-5v28c-6-1-11 1-16 5-5-4-10-6-16-5Z" fill="#fff8dc"/>
    <path d="M24 11v28" fill="none" stroke="#a4bfa2" stroke-width="2"/>
    <path d="m12 14 7 2m-7 5 7 2m10-7 7-2m-7 9 7-2m-24 5 5 1" fill="none" stroke="#9fb5a2" stroke-width="2.2"/>
    <path d="M32 7v12l4-3 4 1V6Z" fill="#ee9877" stroke="#b97558" stroke-width="1.5"/>
  </g>`,
  run: `<g stroke="#305f8e" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="m10 10 9 2c1 9 7 14 18 16 5 1 7 4 6 9H8c-4-4-4-9-2-14Z" fill="#62b8ed"/>
    <path d="m10 10 9 2c0 4 2 8 5 10-7 2-13-1-16-5Z" fill="#c1ecff" stroke-width="2"/>
    <path d="M6 33c9 2 24 1 37 0v6c-11 4-26 3-36 0Z" fill="#fff4d9"/>
    <path d="m21 20-6 4m12-1-6 4m12-1-6 4" fill="none" stroke="#fff7e5" stroke-width="3"/>
    <path d="m6 8-3-3m3 17H2m6 4H3" fill="none" stroke="#6fa4c8" stroke-width="2.4"/>
    <path d="m36 30 2 1" fill="none" stroke="#e2f6ff" stroke-width="3"/>
  </g>`,
  brush: `<g stroke="#885441" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 37c-7-11-3-24 9-28 14-5 26 5 24 18-1 6-5 7-10 4-3-2-6 0-5 4 1 7-10 9-18 2Z" fill="#ffdfaa" stroke="#bb8856"/>
    <circle cx="12" cy="21" r="3.5" fill="#6dbdaf" stroke="none"/><circle cx="20" cy="14" r="3.5" fill="#f39b7b" stroke="none"/><circle cx="30" cy="16" r="3.5" fill="#a38dd4" stroke="none"/>
    <path d="m18 30 17-24c2-3 8 1 6 4L22 33Z" fill="#ea9b6e"/>
    <path d="m18 30 4 3 5-7-5-4Z" fill="#b0c4c4" stroke="#6a8c90" stroke-width="2"/>
    <path d="M18 30c-7-1-4 9-10 10 8 3 16 0 14-7Z" fill="#62b8bd" stroke="#437d88"/>
    <path d="m30 17 6-8" fill="none" stroke="#ffe4b7" stroke-width="2.4"/>
  </g>`,
  sun: `<g stroke="#cc8a20" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M24 3v4m0 34v4M3 24h4m34 0h4M9 9l3 3m24 24 3 3M9 39l3-3m24-24 3-3" fill="none" stroke="#e7a32a" stroke-width="3.8"/>
    <circle cx="24" cy="24" r="13.5" fill="#ffd95a"/>
    <path d="M16 18a10 10 0 0 1 7-4" fill="none" stroke="#fff3ac" stroke-width="3"/>
    <path d="M19 23v2m10-2v2" fill="none" stroke="#8e642f" stroke-width="2.8"/>
    <path d="M20 29q4 4 8 0" fill="none" stroke="#9f6e36" stroke-width="2"/>
    <ellipse cx="16" cy="28" rx="2.5" ry="1.7" fill="#f2a05c" stroke="none"/><ellipse cx="32" cy="28" rx="2.5" ry="1.7" fill="#f2a05c" stroke="none"/>
  </g>`,
  tidy: `<g stroke="#487d94" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 21h32l-3 21H11Z" fill="#78c3d9"/>
    <path d="M5 19h38v8H5Z" fill="#b2e4ec"/>
    <path d="M13 19V8h12v11" fill="#f0bc68" stroke="#b28642"/>
    <path d="m27 19 2-13 11 3-2 10" fill="#a998cf" stroke="#8072a4"/>
    <path d="m17 12 3 2m13-2 3 1" fill="none" stroke="#fff3c8" stroke-width="2.5"/>
    <rect x="18" y="30" width="12" height="5" rx="2.5" fill="#f3f5dd" stroke-width="1.8"/>
    <path d="M11 23h7" fill="none" stroke="#f0ffff" stroke-width="2.5"/>
  </g>`,
  music: `<g stroke="#7859a7" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 33V11l22-6v24l-6 1V17l-10 3v15Z" fill="#b58cdd"/>
    <path d="m18 11 22-6v8l-22 6Z" fill="#d7baf3"/>
    <ellipse cx="16" cy="35" rx="8" ry="6" transform="rotate(-20 16 35)" fill="#b58cdd"/>
    <ellipse cx="32" cy="31" rx="8" ry="6" transform="rotate(-20 32 31)" fill="#b58cdd"/>
    <path d="m23 12 10-3" fill="none" stroke="#f1e4ff" stroke-width="2.5"/>
    <path d="M7 10v6m-3-3h6" fill="none" stroke="#e1b254" stroke-width="2.4"/>
  </g>`,
  star: `<g stroke="#bc852d" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="m24 5 6 12 13 2-9.5 9 2.3 14L24 35l-11.8 7 2.3-14L5 19l13-2Z" fill="#ffd461"/>
    <path d="m24 5 1 17 9 6 2 14L24 35l-12 7 8-16Z" fill="#f2b63f" stroke="none" opacity=".6"/>
    <path d="m24 5 6 12 13 2-9.5 9 2.3 14L24 35l-11.8 7 2.3-14L5 19l13-2Z" fill="none"/>
    <path d="m21 14-3 7-5 1" fill="none" stroke="#fff2b0" stroke-width="3"/>
    <path d="M20 25v2m8-2v2" fill="none" stroke="#95642e" stroke-width="2.6"/>
  </g>`,
  crown: `<g stroke="#ae782d" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="m7 13 10 8 7-13 7 13 10-8-4 25H11Z" fill="#ffd25d"/>
    <path d="m17 21 7 6 7-6-7-13Z" fill="#ffe797" stroke="none"/>
    <rect x="10" y="33" width="28" height="8" rx="3" fill="#efb53e"/>
    <path d="M15 37h17" fill="none" stroke="#ffe99b" stroke-width="2.6"/>
    <path d="m24 22 4 5-4 5-4-5Z" fill="#66c4da" stroke="#3c91a3" stroke-width="1.5"/>
    <circle cx="7" cy="12" r="3.2" fill="#ffde75"/><circle cx="24" cy="7" r="3.2" fill="#ffde75"/><circle cx="41" cy="12" r="3.2" fill="#ffde75"/>
  </g>`,
  hat: `<g stroke="#a0753e" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 30 16 8c6-3 11-3 16 0l4 22Z" fill="#e9bb73"/>
    <path d="m17 11-2 12" fill="none" stroke="#ffe3a6" stroke-width="3"/>
    <path d="m13 25 23 1 1 6H12Z" fill="#74a285" stroke="#4f8068" stroke-width="2.2"/>
    <path d="M4 32c7-6 32-6 40 0-1 9-38 9-40 0Z" fill="#f3d28c"/>
    <path d="M10 33c8-2 20-2 28 0" fill="none" stroke="#ffe8b3" stroke-width="2.6"/>
    <path d="M32 23c7-4 8-9 7-15-6 2-8 7-7 15Z" fill="#8dbb8d" stroke="#4f8068" stroke-width="2"/>
  </g>`,
  gift: `<g stroke="#a85c68" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 22h32v20H8Z" fill="#ed9aa4"/>
    <path d="M19 22h10v20H19Z" fill="#ffdc88" stroke="#bc8b46" stroke-width="2"/>
    <path d="M5 16h38v10H5Z" fill="#ffb9bc"/>
    <path d="M19 16h10v10H19Z" fill="#ffe49d" stroke="#bc8b46" stroke-width="2"/>
    <path d="M24 16C4 18 7-2 17 7Zm0 0C44 18 41-2 31 7Z" fill="#ffdc88" stroke="#bc8b46"/>
    <path d="M12 20h4m-4 10v5" fill="none" stroke="#ffe2df" stroke-width="3"/>
  </g>`,
  play: `<g stroke="#4d8f76" stroke-width="2.6" stroke-linejoin="round">
    <circle cx="24" cy="25" r="19" fill="#57a688"/>
    <circle cx="24" cy="22" r="18" fill="#8dd6ae"/>
    <path d="m19 12 14 10-14 10Z" fill="#fff6da" stroke="#4d8f76" stroke-width="2"/>
    <path d="M11 16a14 14 0 0 1 7-6" fill="none" stroke="#cdf4d5" stroke-width="3" stroke-linecap="round"/>
  </g>`,
  leaf: `<g stroke="#477c4d" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M39 6C15 2 4 14 10 30c8 17 30 8 29-24Z" fill="#8bc46d"/>
    <path d="M39 6C29 14 18 27 10 30c8 17 30 8 29-24Z" fill="#64aa5e" stroke="none"/>
    <path d="M39 6C15 2 4 14 10 30c8 17 30 8 29-24Z" fill="none"/>
    <path d="m7 42 24-26m-13 14-1-10m8 3 9 1" fill="none"/>
    <path d="M15 17c4-5 10-7 15-7" fill="none" stroke="#c5e59e" stroke-width="3"/>
  </g>`,
  home: `<g stroke="#697b4b" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 22h28v21H10Z" fill="#ffdf9e" stroke="#a08147"/>
    <path d="m5 23 19-18 19 18-5 3-14-13-14 13Z" fill="#91b873"/>
    <path d="M20 43V29h9v14" fill="#bf8d56" stroke="#8b693e"/>
    <rect x="13" y="28" width="5" height="6" rx="1" fill="#c5e3e8" stroke="#6496a0" stroke-width="1.7"/>
    <path d="m15 18 8-8" fill="none" stroke="#cbe0a1" stroke-width="2.5"/>
    <circle cx="26" cy="36" r="1" fill="#ffe9aa" stroke="none"/>
  </g>`,
  calendar: `<g stroke="#8c775a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="6" y="9" width="36" height="34" rx="6" fill="#fff6dd"/>
    <path d="M12 9h24a6 6 0 0 1 6 6v6H6v-6a6 6 0 0 1 6-6Z" fill="#eaa08b"/>
    <path d="M15 5v9m18-9v9" fill="none" stroke="#a86e58" stroke-width="4"/>
    <path d="M13 27h4m-4 8h4m7-8h4m-4 8h4m7-8h1" fill="none" stroke="#b8ab87" stroke-width="3"/>
    <path d="m32 34 3 3 5-6" fill="none" stroke="#77a17b" stroke-width="2.5"/>
  </g>`,
  chart: `<g stroke="#5c8279" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="8" y="25" width="8" height="17" rx="2" fill="#8ac3a5"/>
    <rect x="20" y="17" width="8" height="25" rx="2" fill="#8ac8e0" stroke="#5a91aa"/>
    <rect x="32" y="7" width="8" height="35" rx="2" fill="#efc767" stroke="#ad8b44"/>
    <path d="M5 43h39M11 29v6m12-14v7m12-17v7" fill="none"/>
    <path d="m7 19 8-8 6 2 8-8" fill="none" stroke="#85a969" stroke-width="2.4"/>
  </g>`,
  shop: `<g stroke="#648466" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 19h32v24H8Z" fill="#ffe1ad" stroke="#a78751"/>
    <path d="m5 17 6-11h26l6 11Z" fill="#96c48b"/>
    <path d="m18 6-2 11h8V6Zm12 0 2 11h8L35 6Z" fill="#fff4d1" stroke="none"/>
    <path d="m5 17 6-11h26l6 11Z" fill="none"/>
    <path d="M5 17h10v3c0 7-10 7-10 0Zm10 0h9v3c0 7-9 7-9 0Zm9 0h9v3c0 7-9 7-9 0Zm9 0h10v3c0 7-10 7-10 0Z" fill="#b8d89c" stroke-width="2"/>
    <path d="M24 43V29h10v14" fill="#be945e" stroke="#a78751" stroke-width="2"/>
    <rect x="12" y="29" width="8" height="8" rx="1" fill="#a8d4da" stroke="#6d9fa4" stroke-width="2"/>
  </g>`,
  settings: `<g stroke="#5b8292" stroke-width="2.6" stroke-linejoin="round">
    <path d="m18 5-2 6-6 1-5 9 4 5-1 7 9 7 7-2 7 2 9-7-1-7 4-5-5-9-6-1-2-6Z" fill="#9fcbd5"/>
    <circle cx="24" cy="24" r="9" fill="#eaf5e8"/>
    <circle cx="24" cy="24" r="4" fill="#7eafb8" stroke-width="2"/>
    <path d="m19 10-1 5-5 1" fill="none" stroke="#d9edf0" stroke-width="3" stroke-linecap="round"/>
  </g>`,
  lock: `<g stroke="#a68043" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 22V13a10 10 0 0 1 20 0v9h-6v-9a4 4 0 0 0-8 0v9Z" fill="#b5cbd1" stroke="#718e97"/>
    <rect x="8" y="20" width="32" height="24" rx="6" fill="#f5cb73"/>
    <path d="M13 27v7" fill="none" stroke="#ffedb3" stroke-width="3"/>
    <circle cx="24" cy="30" r="3" fill="#a37a3d" stroke-width="1.5"/><path d="M24 32v5" fill="none" stroke-width="3"/>
  </g>`,
  camera: `<g stroke="#5e8297" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 13h7l4-7h10l4 7h7a4 4 0 0 1 4 4v23H4V17a4 4 0 0 1 4-4Z" fill="#9ac9e0"/>
    <path d="M4 30h40v10H4Z" fill="#75abc5" stroke="none"/>
    <circle cx="24" cy="26" r="10" fill="#ecf4e9"/><circle cx="24" cy="26" r="6" fill="#67b5d6" stroke-width="2"/>
    <path d="m21 24 2-2" fill="none" stroke="#d8f5ff" stroke-width="2.5"/>
    <path d="M10 18h3" fill="none" stroke="#fff2bd" stroke-width="3"/>
    <path d="M4 30v10h40V30" fill="none"/>
  </g>`,
  mic: `<g stroke="#806994" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="16" y="4" width="16" height="27" rx="8" fill="#be9cda"/>
    <path d="M16 12h5m6 0h5m-16 6h5m6 0h5" fill="none" stroke="#e9d9f5" stroke-width="2"/>
    <path d="M10 23v2a14 14 0 0 0 28 0v-2m-14 16v5m-7 0h14" fill="none" stroke-width="3"/>
    <path d="M20 9q3-3 6-1" fill="none" stroke="#f1e8fc" stroke-width="2.5"/>
  </g>`,
  message: `<g stroke="#b09356" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 6h28a5 5 0 0 1 5 5v22a5 5 0 0 1-5 5H24l-10 7v-7h-4a5 5 0 0 1-5-5V11a5 5 0 0 1 5-5Z" fill="#ffe3a1"/>
    <path d="M13 15h22m-22 8h17m-17 8h10" fill="none" stroke="#bb9c60" stroke-width="2.5"/>
    <path d="M10 11h10" fill="none" stroke="#fff4d3" stroke-width="2.5"/>
  </g>`,
  user: `<g stroke="#8c7759" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M7 44v-6c0-18 34-18 34 0v6Z" fill="#95c39b" stroke="#608b68"/>
    <path d="m17 29 7 8 7-8" fill="#fff2d9" stroke="#608b68" stroke-width="2"/>
    <circle cx="24" cy="16" r="12" fill="#ffdcad"/>
    <path d="M12 15C9 2 30-2 35 10l1 5c-6 0-12-3-15-6-1 4-4 6-9 6Z" fill="#bf9868"/>
    <path d="M20 18v1m9-1v1" fill="none" stroke-width="2"/>
    <path d="M22 23q2 2 4 0" fill="none" stroke-width="1.6"/>
  </g>`,
};
