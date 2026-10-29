import './island-object-art.css';

// 分部件模型沿用原始素材坐标；目录决定哪些局部部件可以运动。
const objectModels = ['island-windmill-v1', 'island-fountain-v1', 'island-swing-v1', 'island-lantern-v1', 'island-flowers-v1'];

// 静态图片仍负责其余物件，避免无关模型进入分部件渲染。
export function supportsObjectArtwork(model: string): boolean { return objectModels.includes(model); }

// 保持原120像素图片的缩放与锚点，使动画不改变物品的位置或占地。
export function IslandObjectArtwork({ model }: { model: string }) {
  return <g className="island-object-art" transform="translate(-60 -99.375) scale(.375)" fill="none">
    {model === 'island-windmill-v1' && <>
      <ellipse className="island-object-base" cx="160" cy="266" rx="111" ry="20" fill="#607950" opacity=".15"/>
      <g stroke="#78674f" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="m109 252 14-124h74l14 124q-50 26-102 0Z" fill="#edddba"/>
        <path d="m160 135 37-7 14 124q-22 14-51 15Z" fill="#d8c49f" stroke="none"/>
        <path d="m112 130 48-61 49 61Z" fill="#b7816c"/>
        <path d="m123 125 37-48 37 48" stroke="#d7a183" strokeWidth="4"/>
        <path d="M145 259v-34q15-17 30 0v34" fill="#9bb2a0" stroke="#7a8c73"/>
        <path d="M146 181v-22h27v22Z" fill="#b3d2c8" stroke="#899782"/><path d="M159 159v22m-13-11h27" stroke="#f8edce" strokeWidth="3"/>
        <g transform="translate(160 119) rotate(-25)">
          <g className="island-windmill-blades">
            <path d="M-5-5v-87h24v57L5 5h87v24H35L-5 5v87h-24V35L-5-5h-87v-24h57Z" fill="#d4b68a"/>
            <path d="M3-80h10M3-64h10M3-48h10m67 51v10M64 3v10M48 3v10M-3 80h-10m10-16h-10m10-16h-10M-80-3v-10m16 10v-10m16 10v-10" stroke="#f7e6ba" strokeWidth="4"/>
            <circle r="11" fill="#edcb8c"/><circle r="3" fill="#9b8059" stroke="none"/>
          </g>
        </g>
        <path d="m94 267 8-16m114 16 9-10" stroke="#809d64" strokeWidth="5"/>
      </g>
    </>}
    {model === 'island-fountain-v1' && <>
      <ellipse className="island-object-base" cx="160" cy="266" rx="111" ry="20" fill="#607950" opacity=".15"/>
      <g stroke="#78674f" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="160" cy="247" rx="106" ry="33" fill="#b1bfae" stroke="#7c9387"/>
        <path d="M54 228v17c1 42 211 44 212 0v-17" fill="#c9d2be" stroke="#7c9387"/>
        <ellipse cx="160" cy="228" rx="106" ry="32" fill="#a5cfcb" stroke="#7c9387"/>
        <ellipse className="island-fountain-ripple" cx="160" cy="229" rx="85" ry="21" stroke="#deece0" strokeWidth="3"/>
        <path d="M142 215v-66h36v66q-18 12-36 0Z" fill="#c9d2be" stroke="#7c9387"/>
        <path d="M103 142v13c1 26 113 26 114 0v-13" fill="#b6c5b4" stroke="#7c9387"/>
        <ellipse cx="160" cy="142" rx="57" ry="18" fill="#b3d8cf" stroke="#7c9387"/>
        <path d="M160 126V91" stroke="#849d8e" strokeWidth="13"/>
        <g className="island-fountain-water">
          <path d="M160 114q-7-51-37-36-21 12-11 52m49-17q5-56 33-36 21 17 13 53" stroke="#9acacc" strokeWidth="7"/>
          <path d="M160 105q-13-26 0-48 15 21 0 48Z" fill="#a6d7d2" stroke="#7fafaa"/>
          <path d="m110 165-5 37m110-37 5 37" stroke="#b8e1db" strokeWidth="7"/>
        </g>
        <path d="m71 249 20 9m146-9-15 8" stroke="#e4e7ce" strokeWidth="4"/>
      </g>
    </>}
    {model === 'island-swing-v1' && <>
      <ellipse className="island-object-base" cx="160" cy="266" rx="111" ry="20" fill="#607950" opacity=".15"/>
      <g stroke="#78674f" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="m59 256 35-159 37 170m74-16 31-157 40 146" stroke="#836f51" strokeWidth="11"/>
        <path d="m95 96 142 1" stroke="#b99668" strokeWidth="14"/>
        <path d="m95 93 140 1" stroke="#dfbf90" strokeWidth="5"/>
        <g className="island-swing-seat">
          <path d="m123 101-4 116m83-116-4 122" stroke="#b8a076" strokeWidth="4"/>
          <path d="m103 215 23-9 88 11-22 12Z" fill="#dfbc8b"/>
          <path d="M103 215v9l89 13v-8Z" fill="#bd9569"/><path d="m192 229 22-12v9l-22 11Z" fill="#cda879"/>
          <path d="m119 216 73 11" stroke="#f4d9ad" strokeWidth="3"/>
        </g>
        <path d="m73 191 43 7m104-7 41-2" stroke="#bfa176" strokeWidth="6"/>
        <g fill="#947751" stroke="none"><circle cx="96" cy="104" r="4"/><circle cx="235" cy="105" r="4"/></g>
        <path d="m47 265 6-16m78 25 6-13m129-13 9-7" stroke="#809d64" strokeWidth="5"/>
      </g>
    </>}
    {model === 'island-lantern-v1' && <>
      <ellipse className="island-object-base" cx="160" cy="266" rx="111" ry="20" fill="#607950" opacity=".15"/>
      <g stroke="#78674f" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="160" cy="260" rx="45" ry="12" fill="#c7bea0"/>
        <path d="M144 254v-15h32v15Z" fill="#8ba18d"/><path d="M153 239V119h14v120Z" fill="#a8b4a0"/>
        <path d="M139 242h42m-23-14h4" stroke="#6f826d" strokeWidth="5"/>
        <ellipse className="island-lantern-glow" cx="160" cy="83" rx="42" ry="37" fill="#fff1bb" stroke="none" opacity=".12"/>
        <path d="m124 111 7-58h58l7 58Z" fill="#f8dea0"/>
        <path d="M139 58v48m42-48v48" stroke="#ad9569" strokeWidth="4"/>
        <path d="m117 54 43-24 43 24Z" fill="#8ca38c" stroke="#6f826d"/>
        <path d="M119 113h82v9h-82Z" fill="#8ca38c" stroke="#6f826d"/>
        <path d="M160 30V20m-26 94 26 13 26-13" stroke="#6f826d"/>
        <path className="island-lantern-flame" d="M153 96q-12-14 5-27 0 11 9 17 6 13-8 16" fill="#fff1bb" stroke="#ddb66e" strokeWidth="2"/>
        <path className="island-lantern-rays" d="m110 72-12-4m112 4 12-4m-113 27-9 5m111-5 9 5" stroke="#e5c480" strokeWidth="4"/>
        <path d="m124 266 7-10m59 10 6-10" stroke="#7f9b63" strokeWidth="4"/>
      </g>
    </>}
    {model === 'island-flowers-v1' && <>
      <ellipse className="island-object-base" cx="160" cy="266" rx="111" ry="20" fill="#607950" opacity=".15"/>
      <g stroke="#78674f" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M59 253q23-27 58-15 31-27 65-6 49-23 81 20-84 35-204 1Z" fill="#a5be7b" stroke="#779657"/>
        <g className="island-flowers-stems" style={{ transformOrigin: '105px 251px' }}>
          <path d="M105 251v-83m0 54-27-19m27 4 27-21" stroke="#6d9159" strokeWidth="7"/>
          <path d="M105 221q-32 0-33-22 26-1 33 22Z" fill="#83a970" stroke="#6d9159"/>
          <g fill="#f1b9a9" stroke="#bd8576"><circle cx="105" cy="139" r="18"/><circle cx="80" cy="154" r="18"/><circle cx="88" cy="181" r="18"/><circle cx="118" cy="181" r="18"/><circle cx="130" cy="154" r="18"/></g>
          <circle cx="105" cy="162" r="17" fill="#f3d47d" stroke="#c59d57"/>
        </g>
        <g className="island-flowers-stems" style={{ transformOrigin: '183px 248px', animationDelay: '-1.6s' }}>
          <path d="M183 248v-104m0 70-25-21m25-9 24-18" stroke="#6d9159" strokeWidth="7"/>
          <path d="M183 213q24-25 36-16-5 24-36 16Z" fill="#83a970" stroke="#6d9159"/>
          <g fill="#faf0ca" stroke="#c5ae79"><circle cx="182" cy="114" r="15"/><circle cx="162" cy="129" r="15"/><circle cx="170" cy="151" r="15"/><circle cx="195" cy="151" r="15"/><circle cx="204" cy="128" r="15"/></g>
          <circle cx="183" cy="134" r="13" fill="#e8b468" stroke="#c59d57"/>
        </g>
        <g className="island-flowers-stems" style={{ transformOrigin: '230px 250px', animationDelay: '-3s' }}>
          <path d="M230 250v-69" stroke="#6d9159" strokeWidth="7"/>
          <path d="M226 192q-32-5-24-23 9-15 24-4 12-22 26-7 12 19-9 30Z" fill="#c1b6d9" stroke="#9987ac"/><circle cx="227" cy="178" r="8" fill="#ffe5a1" stroke="#bfa060"/>
        </g>
        <path d="m77 252 7-9m155 13 7-10" stroke="#718e51"/>
      </g>
    </>}
  </g>;
}
