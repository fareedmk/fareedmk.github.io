export default function ProductArt({ name, category = "" }: { name: string; category?: string }) {
  const gelato = /gelato|cone|scoop/i.test(`${name} ${category}`);
  const food = /pastr|food|croissant|sandwich|toast/i.test(`${name} ${category}`);
  return (
    <svg viewBox="0 0 320 230" role="img" aria-label={`${name} illustration`} className="product-art">
      <ellipse cx="160" cy="199" rx="83" ry="12" fill="#352d2312" />
      {gelato ? <>
        <path d="m111 126 49 78 49-78Z" fill="#d9a66b" />
        <path d="m127 140 54 42m-42-51 54 40m-13-41-45 55m55-42-41 53" stroke="#b9844e" strokeWidth="3" />
        <circle cx="130" cy="117" r="36" fill="#dfb2ad" />
        <circle cx="190" cy="117" r="36" fill="#a8b895" />
        <circle cx="160" cy="72" r="37" fill="#f4dfb9" />
        <path d="m143 56 13-4m-28 58 9-5m42 2 11 3" stroke="#fff8" strokeWidth="5" strokeLinecap="round" />
      </> : food ? <>
        <ellipse cx="160" cy="176" rx="100" ry="22" fill="#f7f2e5" />
        <path d="M73 148q17-65 87-59 70-6 87 59l-30 24-38-13-19 8-19-8-38 13Z" fill="#d7a15d" />
        <path d="m106 105 13 52m27-66 4 66m27-66-7 65m37-51-15 51" stroke="#a86e38" strokeWidth="6" />
        <path d="m116 106 6 25m23-28 2 27m33-23-4 26" stroke="#f7dba0" strokeWidth="6" strokeLinecap="round" />
      </> : <>
        <path d="M208 90h15q40 0 27 39-6 20-35 20" fill="none" stroke="#c7b197" strokeWidth="13" />
        <path d="m100 78 12 99q49 26 98 0l12-99Z" fill="#f3eee0" />
        <ellipse cx="161" cy="79" rx="61" ry="18" fill="#d1b59a" />
        <ellipse cx="161" cy="79" rx="52" ry="12" fill="#876249" />
        <path d="M143 77q19-20 36-1-12 15-18 11-10-4-18-10Z" fill="#eee0c4" />
        <path d="M143 49q-15-15 1-29m30 29q-15-15 1-29" stroke="#ac9c8660" strokeWidth="4" fill="none" strokeLinecap="round" />
        <text x="160" y="145" textAnchor="middle" fontFamily="Georgia,serif" fontSize="28" fill="#4b624d">YaFI</text>
      </>}
    </svg>
  );
}
