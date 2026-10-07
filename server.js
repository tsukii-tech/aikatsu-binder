// アイカツ！バインダー サーバー（依存パッケージなし / Node.js 18+）
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA = path.join(DATA_DIR, 'cards.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const USER_DATA_FILE = path.join(DATA_DIR, 'user-data.json');
const CACHE = path.join(DATA_DIR, 'imgcache');

const TYPES = ['cute', 'cool', 'sexy', 'pop'];

const CATS = [
  'トップス',
  'ボトムス',
  'トップス&ボトムス',
  'シューズ',
  'アクセサリー',
  'パラレルカード'
];

/* 管理者のパーソナライズ設定 */
const ADMIN_COLORS = [
  'pink',
  'red',
  'orange',
  'yellow',
  'blue',
  'purple'
];

const ADMIN_ICONS = [
  'heart',
  'diamond',
  'spade',
  'club'
];

const OFFICIAL = 'https://dcd.aikatsu.com/';
const DEFAULT_BASE = 'https://dcd.aikatsu.com/encore/cardlist/';

const SUFFIX =
  /^\s*([A-Za-z0-9]+-\d+[A-Za-z0-9_]*)(?:[\s_\-]*(表面|裏面|表|裏))?\s*$/;

const splitNo = (s) => {
  const m = String(s || '').match(SUFFIX);

  if (!m) return null;

  return {
    no: m[1].replace(/[_-]+$/, ''),
    side: m[2]
      ? (m[2][0] === '裏' ? 'back' : 'front')
      : ''
  };
};

const normalizeCardNo = (s) => {
  const sp = splitNo(s);

  if (sp) return sp.no;

  return String(s || '')
    .trim()
    .replace(/[\s_\-]*(表面|裏面|表|裏)\s*$/u, '')
    .trim();
};

const seriesOf = (no) => {
  const m = String(no || '').match(/^[A-Za-z]+(\d+)-/);
  return m ? `${m[1]}弾` : '';
};

/* ===================== ファイル初期化 ===================== */

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

if (!fs.existsSync(DATA)) {
  fs.writeFileSync(DATA, JSON.stringify([], null, 2));
}

if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2));
}

if (!fs.existsSync(USER_DATA_FILE)) {
  fs.writeFileSync(USER_DATA_FILE, JSON.stringify({}, null, 2));
}

const load = () => {
  try {
    const v = JSON.parse(
      fs.readFileSync(DATA, 'utf8')
    );

    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const save = (cards) => {
  fs.writeFileSync(
    DATA,
    JSON.stringify(cards, null, 2)
  );
};

const loadUsers = () => {
  try {
    const v = JSON.parse(
      fs.readFileSync(USERS_FILE, 'utf8')
    );

    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const saveUsers = (users) => {
  fs.writeFileSync(
    USERS_FILE,
    JSON.stringify(users, null, 2)
  );
};

const loadUserData = () => {
  try {
    const v = JSON.parse(
      fs.readFileSync(USER_DATA_FILE, 'utf8')
    );

    return v && typeof v === 'object'
      ? v
      : {};
  } catch {
    return {};
  }
};

const saveUserData = (data) => {
  fs.writeFileSync(
    USER_DATA_FILE,
    JSON.stringify(data, null, 2)
  );
};

/*
 * 旧バージョンでカード自体に入っていた
 * 「IDと同じQR」を初期値として扱っていた場合だけ削除。
 */
(function migrateDefaultQr() {
  const cards = load();
  let changed = false;

  const fixed = cards.map((c) => {
    if (c.qr && c.no && c.qr === c.no) {
      changed = true;

      return {
        ...c,
        qr: ''
      };
    }

    return c;
  });

  if (changed) {
    save(fixed);

    console.log(
      '[migrate] 初期値として入っていたQRをクリアしました'
    );
  }
})();

/* ===================== カードデータ ===================== */

const clean = (c, id) => ({
  id: String(id || c.id || Date.now()),
  no: String(c.no || '').slice(0, 40),
  name: String(c.name || '名称未設定').slice(0, 80),
  type: TYPES.includes(c.type)
    ? c.type
    : 'cute',
  category: CATS.includes(c.category)
    ? c.category
    : 'トップス',
  img: String(c.img || '').slice(0, 500),
  imgBack: String(c.imgBack || '').slice(0, 500),
  qr: String(c.qr || '').slice(0, 200),
  owned: !!c.owned,
  ap: Number.isFinite(+c.ap)
    ? Math.max(
        0,
        Math.min(9999, +c.ap)
      )
    : 400
});

const withSeries = (c) => ({
  ...c,
  series: seriesOf(c.no)
});

/*
 * 管理者からは一般ユーザーの
 * 所持・QRを変更できないようにする。
 */
const stripPublicOnlyFields = (body) => {
  const b = { ...body };

  delete b.qr;
  delete b.owned;

  return b;
};

const sendJson = (res, code, obj) => {
  res.writeHead(code, {
    'Content-Type':
      'application/json; charset=utf-8'
  });

  res.end(
    JSON.stringify(obj)
  );
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let b = '';

    req.on('data', (d) => {
      b += d;

      if (b.length > 2e7) {
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(
          b
            ? JSON.parse(b)
            : {}
        );
      } catch (e) {
        reject(e);
      }
    });
  });

/* ===================== パスワード ===================== */

const hashPassword = (pw, salt) =>
  crypto.scryptSync(
    String(pw),
    salt,
    64
  );

const makeHash = (pw) => {
  const salt =
    crypto.randomBytes(16).toString('hex');

  return {
    salt,
    hash: hashPassword(
      String(pw),
      salt
    ).toString('hex')
  };
};

const checkHash = (
  pw,
  salt,
  hash
) => {
  try {
    const a =
      Buffer.from(hash, 'hex');

    const b =
      hashPassword(
        String(pw),
        salt
      );

    return (
      a.length === b.length &&
      crypto.timingSafeEqual(
        a,
        b
      )
    );
  } catch {
    return false;
  }
};

function makeLimiter(
  limit,
  windowMs
) {
  const hits = new Map();

  return (key) => {
    const now = Date.now();

    const arr =
      (hits.get(key) || [])
        .filter(
          (t) =>
            now - t <
            windowMs
        );

    arr.push(now);

    hits.set(
      key,
      arr
    );

    return arr.length > limit;
  };
}

/* ===================== セッション ===================== */

const SESSION_TTL =
  12 * 60 * 60 * 1000;

const USER_SESSION_TTL =
  14 * 24 * 60 * 60 * 1000;

const sessions = new Map();

const newSession = (
  role,
  userId,
  ttl
) => {
  const sid =
    crypto
      .randomBytes(32)
      .toString('hex');

  sessions.set(
    sid,
    {
      role,
      userId:
        userId || null,
      exp:
        Date.now() + ttl
    }
  );

  return sid;
};

const getSession = (
  sid,
  role
) => {
  if (!sid) {
    return null;
  }

  const s =
    sessions.get(sid);

  if (
    !s ||
    s.role !== role
  ) {
    return null;
  }

  if (
    s.exp <
    Date.now()
  ) {
    sessions.delete(sid);

    return null;
  }

  s.exp =
    Date.now() +
    (
      role === 'admin'
        ? SESSION_TTL
        : USER_SESSION_TTL
    );

  return s;
};

const parseCookies = (
  req
) => {
  const out = {};

  (req.headers.cookie || '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .forEach((p) => {
      const i =
        p.indexOf('=');

      if (i < 0) {
        return;
      }

      try {
        out[
          p.slice(0, i)
        ] =
          decodeURIComponent(
            p.slice(i + 1)
          );
      } catch {
        out[
          p.slice(0, i)
        ] =
          p.slice(i + 1);
      }
    });

  return out;
};

const isAdminReq = (
  req
) =>
  !!getSession(
    parseCookies(req)
      .aikatsu_admin_sid || '',
    'admin'
  );

const getUserId = (
  req
) =>
  getSession(
    parseCookies(req)
      .aikatsu_user_sid || '',
    'user'
  )?.userId || null;

const setCookie = (
  res,
  name,
  value,
  maxAgeSec
) => {
  const secure =
    process.env.NODE_ENV ===
    'production'
      ? '; Secure'
      : '';

  res.setHeader(
    'Set-Cookie',
    `${name}=${encodeURIComponent(
      value
    )}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Strict${secure}`
  );
};

const clearCookie = (
  res,
  name
) =>
  setCookie(
    res,
    name,
    '',
    0
  );

/* ===================== PC判定 ===================== */

const isPcUA = (
  req
) => {
  if (
    req.headers[
      'sec-ch-ua-mobile'
    ] === '?1'
  ) {
    return false;
  }

  return !/Mobi|Android|iPhone|iPad|iPod|Windows Phone/i.test(
    req.headers[
      'user-agent'
    ] || ''
  );
};

const adminLoginLimiter =
  makeLimiter(
    10,
    15 * 60 * 1000
  );

const userLoginLimiter =
  makeLimiter(
    10,
    15 * 60 * 1000
  );

function requireAdmin(
  req,
  res
) {
  if (!isPcUA(req)) {
    sendJson(
      res,
      403,
      {
        error:
          '管理者機能はパソコンからのみ利用できます'
      }
    );

    return false;
  }

  if (!isAdminReq(req)) {
    sendJson(
      res,
      401,
      {
        error:
          '管理者ログインが必要です'
      }
    );

    return false;
  }

  return true;
}

function requireUser(
  req,
  res
) {
  const uid =
    getUserId(req);

  if (!uid) {
    sendJson(
      res,
      401,
      {
        error:
          'ログインが必要です'
      }
    );

    return null;
  }

  return uid;
}

/* ===================== 一般ユーザー ===================== */

const findUser = (
  username
) => {
  const n =
    String(username || '')
      .trim()
      .toLowerCase();

  return (
    loadUsers().find(
      (u) =>
        String(
          u.username || ''
        ).toLowerCase() ===
        n
    ) || null
  );
};

function verifyUserPassword(
  user,
  password
) {
  return (
    !!user &&
    checkHash(
      password,
      user.salt,
      user.hash
    )
  );
}

/*
 * 一般ユーザー用カード一覧。
 */
function publicCardsForUser(
  cards,
  userId
) {
  const allData =
    loadUserData();

  const users =
    loadUsers();

  const nameById =
    new Map(
      users.map(
        (u) => [
          u.id,
          u.username
        ]
      )
    );

  const mine =
    allData[userId] || {};

  return cards.map((c) => {
    const owners = [];

    for (
      const [
        uid,
        bucket
      ] of Object.entries(
        allData
      )
    ) {
      if (
        uid === userId
      ) {
        continue;
      }

      if (
        bucket?.[c.id]?.owned
      ) {
        const name =
          nameById.get(uid);

        if (name) {
          owners.push(name);
        }
      }
    }

    owners.sort(
      (a, b) =>
        a.localeCompare(
          b,
          'ja'
        )
    );

    return withSeries({
      ...c,
      owned:
        !!mine[c.id]?.owned,
      qr:
        String(
          mine[c.id]?.qr ||
            ''
        ),
      favorite:
        !!mine[c.id]?.favorite,
      owners
    });
  });
}

/* ===================== 公式HTML取り込み ===================== */

const guess = (
  name
) => ({
  type:
    /クール/.test(name)
      ? 'cool'
      : /セクシー/.test(name)
        ? 'sexy'
        : /ポップ/.test(name)
          ? 'pop'
          : 'cute',

  category:
    /ワンピ/.test(name)
      ? 'トップス&ボトムス'
      : /シューズ|ブーツ|ヒール|サンダル|スニーカー/.test(
          name
        )
        ? 'シューズ'
        : /スカート|パンツ|ボトム|ショーツ/.test(
            name
          )
          ? 'ボトムス'
          : /リボン|アクセ|ネックレス|バッグ|ヘア|ティアラ|ピアス/.test(
              name
            )
            ? 'アクセサリー'
            : 'トップス'
});

const linesOf = (
  h
) =>
  h
    .replace(
      /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi,
      ''
    )
    .replace(
      /<[^>]+>/g,
      '\n'
    )
    .replace(
      /&amp;/g,
      '&'
    )
    .replace(
      /&nbsp;/g,
      ' '
    )
    .split('\n')
    .map(
      (s) => s.trim()
    )
    .filter(Boolean);

function modalInfo(
  html,
  no
) {
  const i =
    html.indexOf(
      'id="cardModal-' +
        no +
        '"'
    );

  if (i < 0) {
    return null;
  }

  let j =
    html.indexOf(
      'id="cardModal-',
      i + 10
    );

  if (
    j < 0 ||
    j - i > 8000
  ) {
    j = i + 8000;
  }

  const lines =
    linesOf(
      html.slice(
        i,
        j
      )
    );

  const text =
    lines.join(' ');

  const out = {};

  const cat =
    text.match(
      /トップス&ボトムス|トップス|ボトムス|シューズ|アクセサリー/
    );

  if (cat) {
    out.category =
      cat[0];
  }

  const type =
    text.match(
      /キュート|クール|セクシー|ポップ/
    );

  if (type) {
    out.type = {
      'キュート': 'cute',
      'クール': 'cool',
      'セクシー': 'sexy',
      'ポップ': 'pop'
    }[type[0]];
  }

  return out;
}

function parseCards(
  html,
  base
) {
  const imgs =
    [
      ...html.matchAll(
        /<img[^>]+>/gi
      )
    ];

  console.log(
    `[import] HTML ${html.length}文字, img ${imgs.length}個, 基準URL ${base}`
  );

  const map =
    new Map();

  for (
    const m of imgs
  ) {
    const src =
      (
        m[0].match(
          /data-(?:src|original)=["']([^"']+)["']/
        ) ||
        m[0].match(
          /src=["']([^"']+)["']/
        ) ||
        []
      )[1];

    const alt =
      (
        m[0].match(
          /alt=["']([^"']+)["']/
        ) || []
      )[1];

    if (
      !src ||
      !alt
    ) {
      continue;
    }

    const sp =
      splitNo(
        alt.trim()
      );

    if (
      !sp &&
      !/\/card\//i.test(
        src
      )
    ) {
      continue;
    }

    let abs;

    try {
      abs =
        new URL(
          src,
          base
        ).href;
    } catch {
      continue;
    }

    const key =
      sp
        ? sp.no
        : abs;

    const e =
      map.get(key) || {
        no:
          sp
            ? sp.no
            : '',
        label:
          alt.trim(),
        front: '',
        back: '',
        thumb: ''
      };

    if (
      sp?.side ===
      'back'
    ) {
      e.back =
        e.back ||
        abs;
    } else if (
      sp?.side ===
      'front'
    ) {
      e.front =
        e.front ||
        abs;
    } else {
      e.thumb =
        e.thumb ||
        abs;
    }

    map.set(
      key,
      e
    );
  }

  const out = [];

  for (
    const e of map.values()
  ) {
    const info =
      e.no
        ? modalInfo(
            html,
            e.no
          )
        : null;

    const name =
      e.no ||
      e.label;

    const g =
      guess(name);

    out.push(
      clean(
        {
          no: e.no,
          name,
          img:
            e.front ||
            e.thumb,
          imgBack:
            e.back,
          type:
            info?.type ||
            g.type,
          category:
            info?.category ||
            g.category
        },
        Date.now() +
          '-' +
          out.length
      )
    );
  }

  console.log(
    `[import] カード ${out.length}枚`
  );

  return out.slice(
    0,
    400
  );
}

/* ===================== カード統合 ===================== */

function mergeCards(
  cards,
  found
) {
  let added = 0;
  let updated = 0;

  for (
    const f of found
  ) {
    const normalizedFoundNo =
      normalizeCardNo(
        f.no
      );

    const i =
      normalizedFoundNo
        ? cards.findIndex(
            (c) =>
              normalizeCardNo(
                c.no
              ) ===
              normalizedFoundNo
          )
        : -1;

    if (i >= 0) {
      const old =
        cards[i];

      const next = {
        ...old
      };

      let changed =
        false;

      next.id =
        old.id;

      if (
        !next.no &&
        f.no
      ) {
        next.no =
          f.no;

        changed = true;
      }

      if (
        (!next.name ||
          next.name ===
            '名称未設定') &&
        f.name
      ) {
        next.name =
          f.name;

        changed = true;
      }

      if (
        (!next.type ||
          !TYPES.includes(
            next.type
          )) &&
        TYPES.includes(
          f.type
        )
      ) {
        next.type =
          f.type;

        changed = true;
      }

      if (
        (!next.category ||
          !CATS.includes(
            next.category
          )) &&
        CATS.includes(
          f.category
        )
      ) {
        next.category =
          f.category;

        changed = true;
      }

      if (
        !next.img &&
        f.img
      ) {
        next.img =
          f.img;

        changed = true;
      }

      if (
        !next.imgBack &&
        f.imgBack
      ) {
        next.imgBack =
          f.imgBack;

        changed = true;
      }

      if (
        (!Number.isFinite(
          +next.ap
        ) ||
          +next.ap === 0) &&
        Number.isFinite(
          +f.ap
        )
      ) {
        next.ap =
          f.ap;

        changed = true;
      }

      cards[i] =
        clean(
          next,
          old.id
        );

      if (changed) {
        updated++;
      }
    } else {
      cards.push(
        clean(
          {
            ...f,
            no:
              normalizedFoundNo ||
              f.no
          },
          f.id
        )
      );

      added++;
    }
  }

  return {
    added,
    updated
  };
}

/* ===================== カード整理 ===================== */

function fixImageUrl(
  u
) {
  u =
    String(u || '');

  if (
    u.startsWith(
      '/img?u='
    )
  ) {
    try {
      u =
        decodeURIComponent(
          u.slice(7)
        );
    } catch {}
  }

  return u.replace(
    'https://dcd.aikatsu.com/images/',
    'https://dcd.aikatsu.com/encore/images/'
  );
}

function tidy(
  cards
) {
  const map =
    new Map();

  const plain = [];

  const idMap =
    new Map();

  for (
    const original of cards
  ) {
    const c = {
      ...original,
      img:
        fixImageUrl(
          original.img
        ),
      imgBack:
        fixImageUrl(
          original.imgBack
        )
    };

    const byName =
      splitNo(c.name);

    const byNo =
      splitNo(c.no);

    const sp =
      byName ||
      byNo;

    if (!sp) {
      plain.push(c);
      continue;
    }

    const side =
      byName?.side ||
      byNo?.side ||
      '';

    const no =
      sp.no;

    const front =
      side === 'back'
        ? ''
        : c.img;

    const back =
      side === 'back'
        ? (
            c.img ||
            c.imgBack
          )
        : c.imgBack;

    let entry =
      map.get(no);

    if (!entry) {
      entry = {
        ...c,
        no,
        img:
          front ||
          '',
        imgBack:
          back ||
          '',
        _hasFront:
          side !== 'back',
        _sourceIds:
          [c.id]
      };

      map.set(
        no,
        entry
      );

      continue;
    }

    if (
      !entry._sourceIds.includes(
        c.id
      )
    ) {
      entry._sourceIds.push(
        c.id
      );
    }

    if (
      !entry.img &&
      front
    ) {
      entry.img =
        front;
    }

    if (
      !entry.imgBack &&
      back
    ) {
      entry.imgBack =
        back;
    }

    if (
      !entry._hasFront &&
      side !== 'back'
    ) {
      const oldId =
        entry.id;

      Object.assign(
        entry,
        {
          ...c,
          no,
          img:
            entry.img ||
            front ||
            '',
          imgBack:
            entry.imgBack ||
            back ||
            '',
          _hasFront:
            true
        }
      );

      if (
        oldId &&
        oldId !==
          entry.id
      ) {
        idMap.set(
          oldId,
          entry.id
        );
      }

      entry._sourceIds = [
        ...new Set(
          [
            ...(entry._sourceIds ||
              []),
            oldId,
            c.id
          ].filter(Boolean)
        )
      ];
    } else {
      const entryName =
        String(
          entry.name ||
            ''
        );

      const currentName =
        String(
          c.name ||
            ''
        );

      const entryIsOnlyNo =
        normalizeCardNo(
          entryName
        ) ===
        normalizeCardNo(
          no
        );

      const currentIsBetter =
        currentName &&
        normalizeCardNo(
          currentName
        ) !==
          normalizeCardNo(
            no
          );

      if (
        entryIsOnlyNo &&
        currentIsBetter &&
        side !== 'back'
      ) {
        entry.name =
          currentName;
      }
    }
  }

  const numbered =
    [
      ...map.values()
    ]
      .map(
        (entry) => {
          const c = {
            ...entry
          };

          delete c._hasFront;
          delete c._sourceIds;

          return c;
        }
      )
      .sort(
        (a, b) =>
          a.no.localeCompare(
            b.no,
            'ja',
            {
              numeric:
                true
            }
          )
      );

  const removed =
    cards.length -
    plain.length -
    numbered.length;

  return {
    cards: [
      ...plain,
      ...numbered
    ],
    removed,
    idMap
  };
}

function migrateUserCardIds(
  idMap
) {
  if (
    !idMap ||
    idMap.size === 0
  ) {
    return;
  }

  const data =
    loadUserData();

  for (
    const userId of Object.keys(
      data
    )
  ) {
    const bucket =
      data[userId];

    if (
      !bucket ||
      typeof bucket !==
        'object'
    ) {
      continue;
    }

    for (
      const [
        oldId,
        newId
      ] of idMap.entries()
    ) {
      if (
        oldId ===
        newId
      ) {
        continue;
      }

      const oldData =
        bucket[oldId];

      if (!oldData) {
        continue;
      }

      const newData =
        bucket[newId] ||
        {};

      newData.owned =
        !!newData.owned ||
        !!oldData.owned;

      if (
        !newData.qr &&
        oldData.qr
      ) {
        newData.qr =
          String(
            oldData.qr
          ).slice(
            0,
            200
          );
      }

      bucket[newId] =
        newData;

      delete bucket[
        oldId
      ];
    }
  }

  saveUserData(
    data
  );

  console.log(
    `[migrate] カードID ${idMap.size}件のユーザーデータを移行しました`
  );
}

function tidyAndMigrate(
  cards
) {
  const result =
    tidy(cards);

  migrateUserCardIds(
    result.idMap
  );

  return result;
}

/* ===================== 管理者本体 ===================== */

/*
 * 管理者設定。
 *
 * 旧バージョン：
 * {
 *   salt,
 *   hash,
 *   updatedAt
 * }
 *
 * 新バージョン：
 * {
 *   username,
 *   salt,
 *   hash,
 *   color,
 *   icon,
 *   updatedAt
 * }
 *
 * 既存のadmin.jsonがある場合は、
 * 既存パスワードを維持したまま
 * username / color / iconを自動補完する。
 */

const DEFAULT_ADMIN_USERNAME =
  'admin';

const DEFAULT_ADMIN_COLOR =
  'pink';

const DEFAULT_ADMIN_ICON =
  'heart';

function normalizeAdminSettings(
  data
) {
  const source =
    data &&
    typeof data ===
      'object'
      ? data
      : {};

  return {
    username:
      typeof source.username ===
        'string' &&
      source.username.trim()
        ? source.username.trim()
        : DEFAULT_ADMIN_USERNAME,

    salt:
      String(
        source.salt || ''
      ),

    hash:
      String(
        source.hash || ''
      ),

    color:
      ADMIN_COLORS.includes(
        source.color
      )
        ? source.color
        : DEFAULT_ADMIN_COLOR,

    icon:
      ADMIN_ICONS.includes(
        source.icon
      )
        ? source.icon
        : DEFAULT_ADMIN_ICON,

    updatedAt:
      Number.isFinite(
        +source.updatedAt
      )
        ? +source.updatedAt
        : Date.now()
  };
}

const hasAdminPassword =
  () =>
    fs.existsSync(
      ADMIN_FILE
    );

function loadAdmin() {
  if (
    !hasAdminPassword()
  ) {
    return null;
  }

  try {
    const data =
      JSON.parse(
        fs.readFileSync(
          ADMIN_FILE,
          'utf8'
        )
      );

    const normalized =
      normalizeAdminSettings(
        data
      );

    /*
     * 旧admin.jsonの場合、
     * 新しい設定を補完して保存。
     */
    if (
      JSON.stringify(
        normalized
      ) !==
      JSON.stringify(
        data
      )
    ) {
      fs.writeFileSync(
        ADMIN_FILE,
        JSON.stringify(
          normalized,
          null,
          2
        )
      );
    }

    return normalized;
  } catch {
    return null;
  }
}

function setAdminPassword(
  pw
) {
  const current =
    loadAdmin() || {};

  const hash =
    makeHash(
      String(pw)
    );

  const next = {
    ...current,
    ...hash,
    username:
      current.username ||
      DEFAULT_ADMIN_USERNAME,
    color:
      ADMIN_COLORS.includes(
        current.color
      )
        ? current.color
        : DEFAULT_ADMIN_COLOR,
    icon:
      ADMIN_ICONS.includes(
        current.icon
      )
        ? current.icon
        : DEFAULT_ADMIN_ICON,
    updatedAt:
      Date.now()
  };

  fs.writeFileSync(
    ADMIN_FILE,
    JSON.stringify(
      next,
      null,
      2
    )
  );
}

function setAdminSettings(
  settings
) {
  const current =
    loadAdmin() || {};

  const next = {
    ...current,
    username:
      settings.username !==
      undefined
        ? String(
            settings.username
          ).trim()
        : (
            current.username ||
            DEFAULT_ADMIN_USERNAME
          ),
    color:
      ADMIN_COLORS.includes(
        settings.color
      )
        ? settings.color
        : (
            ADMIN_COLORS.includes(
              current.color
            )
              ? current.color
              : DEFAULT_ADMIN_COLOR
          ),
    icon:
      ADMIN_ICONS.includes(
        settings.icon
      )
        ? settings.icon
        : (
            ADMIN_ICONS.includes(
              current.icon
            )
              ? current.icon
              : DEFAULT_ADMIN_ICON
          ),
    updatedAt:
      Date.now()
  };

  if (
    !next.username
  ) {
    throw new Error(
      'ユーザー名を入力してください'
    );
  }

  fs.writeFileSync(
    ADMIN_FILE,
    JSON.stringify(
      next,
      null,
      2
    )
  );

  return next;
}

function verifyAdminPassword(
  pw
) {
  const admin =
    loadAdmin();

  if (
    !admin ||
    !admin.salt ||
    !admin.hash
  ) {
    return false;
  }

  return checkHash(
    String(pw),
    admin.salt,
    admin.hash
  );
}

/* ===================== MIME ===================== */

const mime = {
  '.html':
    'text/html; charset=utf-8',
  '.js':
    'text/javascript; charset=utf-8',
  '.css':
    'text/css; charset=utf-8',
  '.json':
    'application/json; charset=utf-8',
  '.svg':
    'image/svg+xml',
  '.png':
    'image/png',
  '.jpg':
    'image/jpeg',
  '.jpeg':
    'image/jpeg',
  '.gif':
    'image/gif',
  '.webp':
    'image/webp',
  '.ico':
    'image/x-icon'
};

const imgMime = {
  '.webp':
    'image/webp',
  '.png':
    'image/png',
  '.jpg':
    'image/jpeg',
  '.jpeg':
    'image/jpeg',
  '.gif':
    'image/gif'
};

/* ===================== HTTP SERVER ===================== */

http.createServer(
  async (
    req,
    res
  ) => {
    const url =
      new URL(
        req.url,
        'http://localhost'
      );

    const ip =
      req.socket.remoteAddress ||
      'unknown';

    try {
      /* ---------- 画像プロキシ ---------- */

      if (
        url.pathname ===
        '/img'
      ) {
        try {
          const t =
            new URL(
              url.searchParams.get(
                'u'
              )
            );

          const ext =
            path.extname(
              t.pathname
            ).toLowerCase();

          if (
            !/(^|\.)aikatsu\.com$/.test(
              t.hostname
            ) ||
            !imgMime[ext]
          ) {
            res.writeHead(
              403
            );

            return res.end();
          }

          const file =
            path.join(
              CACHE,
              crypto
                .createHash(
                  'sha1'
                )
                .update(
                  t.href
                )
                .digest(
                  'hex'
                ) +
                ext
            );

          if (
            !fs.existsSync(
              file
            )
          ) {
            const r =
              await fetch(
                t,
                {
                  headers: {
                    'User-Agent':
                      'Mozilla/5.0',
                    Referer:
                      OFFICIAL
                  },
                  signal:
                    AbortSignal.timeout(
                      15000
                    )
                }
              );

            if (
              !r.ok ||
              !(
                r.headers.get(
                  'content-type'
                ) || ''
              ).startsWith(
                'image/'
              )
            ) {
              res.writeHead(
                404
              );

              return res.end();
            }

            fs.writeFileSync(
              file,
              Buffer.from(
                await r.arrayBuffer()
              )
            );
          }

          res.writeHead(
            200,
            {
              'Content-Type':
                imgMime[
                  ext
                ],
              'Cache-Control':
                'public, max-age=86400'
            }
          );

          return fs
            .createReadStream(
              file
            )
            .pipe(res);
        } catch {
          res.writeHead(
            404
          );

          return res.end();
        }
      }

      /* ===================== 一般ユーザー ===================== */

      if (
        url.pathname ===
          '/api/auth/status' &&
        req.method ===
          'GET'
      ) {
        const uid =
          getUserId(req);

        const u =
          uid
            ? loadUsers().find(
                (x) =>
                  x.id === uid
              )
            : null;

        return sendJson(
          res,
          200,
          {
            authed:
              !!u,
            username:
              u?.username ||
              ''
          }
        );
      }

      if (
        url.pathname ===
          '/api/auth/login' &&
        req.method ===
          'POST'
      ) {
        if (
          userLoginLimiter(ip)
        ) {
          return sendJson(
            res,
            429,
            {
              error:
                '試行回数が多すぎます。15分後にお試しください'
            }
          );
        }

        const {
          username,
          password
        } =
          await readBody(
            req
          );

        const u =
          findUser(
            username
          );

        if (
          !u ||
          !verifyUserPassword(
            u,
            String(
              password || ''
            )
          )
        ) {
          return sendJson(
            res,
            401,
            {
              error:
                'ユーザー名またはパスワードが違います'
            }
          );
        }

        setCookie(
          res,
          'aikatsu_user_sid',
          newSession(
            'user',
            u.id,
            USER_SESSION_TTL
          ),
          USER_SESSION_TTL /
            1000
        );

        return sendJson(
          res,
          200,
          {
            ok: true,
            username:
              u.username
          }
        );
      }

      if (
        url.pathname ===
          '/api/auth/logout' &&
        req.method ===
          'POST'
      ) {
        const sid =
          parseCookies(req)
            .aikatsu_user_sid;

        if (sid) {
          sessions.delete(
            sid
          );
        }

        clearCookie(
          res,
          'aikatsu_user_sid'
        );

        return sendJson(
          res,
          200,
          {
            ok: true
          }
        );
      }

      /* ===================== 管理者ログイン ===================== */

      if (
        url.pathname ===
          '/api/admin/status' &&
        req.method ===
          'GET'
      ) {
        const admin =
          loadAdmin();

        return sendJson(
          res,
          200,
          {
            hasPassword:
              hasAdminPassword(),
            authed:
              isAdminReq(req),
            pc:
              isPcUA(req),
            userCount:
              loadUsers().length,

            /*
             * 管理者プロフィール。
             * パスワードそのものは絶対に返さない。
             */
            username:
              admin?.username ||
              DEFAULT_ADMIN_USERNAME,

            color:
              admin?.color ||
              DEFAULT_ADMIN_COLOR,

            icon:
              admin?.icon ||
              DEFAULT_ADMIN_ICON,

            colors:
              ADMIN_COLORS,

            icons:
              ADMIN_ICONS
          }
        );
      }

      /*
       * 初回管理者設定。
       *
       * ユーザー名：
       *   空欄不可
       *
       * パスワード：
       *   長さ・文字種などの制限なし
       *
       * 色：
       *   6色のみ
       *
       * アイコン：
       *   4種類のみ
       */
      if (
        url.pathname ===
          '/api/admin/setup' &&
        req.method ===
          'POST'
      ) {
        if (
          !isPcUA(req)
        ) {
          return sendJson(
            res,
            403,
            {
              error:
                '管理者機能はパソコンからのみ利用できます'
            }
          );
        }

        if (
          hasAdminPassword()
        ) {
          return sendJson(
            res,
            409,
            {
              error:
                'すでに設定済みです'
            }
          );
        }

        const body =
          await readBody(
            req
          );

        const username =
          String(
            body.username ||
              ''
          ).trim();

        const password =
          typeof body.password ===
          'string'
            ? body.password
            : '';

        const color =
          ADMIN_COLORS.includes(
            body.color
          )
            ? body.color
            : DEFAULT_ADMIN_COLOR;

        const icon =
          ADMIN_ICONS.includes(
            body.icon
          )
            ? body.icon
            : DEFAULT_ADMIN_ICON;

        if (
          !username
        ) {
          return sendJson(
            res,
            400,
            {
              error:
                'ユーザー名を入力してください'
            }
          );
        }

        const hash =
          makeHash(
            password
          );

        fs.writeFileSync(
          ADMIN_FILE,
          JSON.stringify(
            {
              username,
              ...hash,
              color,
              icon,
              updatedAt:
                Date.now()
            },
            null,
            2
          )
        );

        setCookie(
          res,
          'aikatsu_admin_sid',
          newSession(
            'admin',
            null,
            SESSION_TTL
          ),
          SESSION_TTL /
            1000
        );

        return sendJson(
          res,
          200,
          {
            ok: true,
            username,
            color,
            icon
          }
        );
      }

      /*
       * 管理者ログイン。
       *
       * 新仕様：
       *   username + password
       *
       * 旧admin.htmlとの互換性のため、
       * usernameが送られてこない場合は
       * 現在の管理者ユーザー名を使用。
       */
      if (
        url.pathname ===
          '/api/admin/login' &&
        req.method ===
          'POST'
      ) {
        if (
          !isPcUA(req)
        ) {
          return sendJson(
            res,
            403,
            {
              error:
                '管理者機能はパソコンからのみ利用できます'
            }
          );
        }

        if (
          adminLoginLimiter(ip)
        ) {
          return sendJson(
            res,
            429,
            {
              error:
                '試行回数が多すぎます。15分後にお試しください'
            }
          );
        }

        const body =
          await readBody(
            req
          );

        const admin =
          loadAdmin();

        const username =
          body.username !==
          undefined
            ? String(
                body.username
              ).trim()
            : (
                admin?.username ||
                DEFAULT_ADMIN_USERNAME
              );

        const password =
          typeof body.password ===
          'string'
            ? body.password
            : '';

        if (
          !admin ||
          username.toLowerCase() !==
            String(
              admin.username ||
                DEFAULT_ADMIN_USERNAME
            ).toLowerCase() ||
          !verifyAdminPassword(
            password
          )
        ) {
          return sendJson(
            res,
            401,
            {
              error:
                'ユーザー名またはパスワードが違います'
            }
          );
        }

        setCookie(
          res,
          'aikatsu_admin_sid',
          newSession(
            'admin',
            null,
            SESSION_TTL
          ),
          SESSION_TTL /
            1000
        );

        return sendJson(
          res,
          200,
          {
            ok: true,
            username:
              admin.username,
            color:
              admin.color,
            icon:
              admin.icon
          }
        );
      }

      if (
        url.pathname ===
          '/api/admin/logout' &&
        req.method ===
          'POST'
      ) {
        const sid =
          parseCookies(req)
            .aikatsu_admin_sid;

        if (sid) {
          sessions.delete(
            sid
          );
        }

        clearCookie(
          res,
          'aikatsu_admin_sid'
        );

        return sendJson(
          res,
          200,
          {
            ok: true
          }
        );
      }

      /*
       * 管理者プロフィール取得。
       */
      if (
        url.pathname ===
          '/api/admin/profile' &&
        req.method ===
          'GET'
      ) {
        if (
          !requireAdmin(
            req,
            res
          )
        ) {
          return;
        }

        const admin =
          loadAdmin();

        return sendJson(
          res,
          200,
          {
            username:
              admin?.username ||
              DEFAULT_ADMIN_USERNAME,
            color:
              admin?.color ||
              DEFAULT_ADMIN_COLOR,
            icon:
              admin?.icon ||
              DEFAULT_ADMIN_ICON,
            colors:
              ADMIN_COLORS,
            icons:
              ADMIN_ICONS
          }
        );
      }

      /*
       * 管理者プロフィール変更。
       *
       * username / color / icon
       * を変更可能。
       *
       * passwordも同時に変更可能。
       * パスワードには長さ制限なし。
       *
       * 変更しない項目は省略可能。
       */
      if (
        url.pathname ===
          '/api/admin/profile' &&
        req.method ===
          'PUT'
      ) {
        if (
          !requireAdmin(
            req,
            res
          )
        ) {
          return;
        }

        const body =
          await readBody(
            req
          );

        const current =
          loadAdmin();

        if (!current) {
          return sendJson(
            res,
            404,
            {
              error:
                '管理者設定が見つかりません'
            }
          );
        }

        const next = {
          ...current
        };

        /*
         * ユーザー名
         */
        if (
          body.username !==
          undefined
        ) {
          const username =
            String(
              body.username
            ).trim();

          if (
            !username
          ) {
            return sendJson(
              res,
              400,
              {
                error:
                  'ユーザー名を入力してください'
              }
            );
          }

          next.username =
            username;
        }

        /*
         * パスワード
         *
         * 長さ制限なし。
         * 空文字も設定可能。
         */
        if (
          body.password !==
          undefined
        ) {
          if (
            typeof body.password !==
            'string'
          ) {
            return sendJson(
              res,
              400,
              {
                error:
                  'パスワードは文字列で指定してください'
              }
            );
          }

          Object.assign(
            next,
            makeHash(
              body.password
            )
          );
        }

        /*
         * カラー
         */
        if (
          body.color !==
          undefined
        ) {
          if (
            !ADMIN_COLORS.includes(
              body.color
            )
          ) {
            return sendJson(
              res,
              400,
              {
                error:
                  '選択できないカラーです'
              }
            );
          }

          next.color =
            body.color;
        }

        /*
         * アイコン
         */
        if (
          body.icon !==
          undefined
        ) {
          if (
            !ADMIN_ICONS.includes(
              body.icon
            )
          ) {
            return sendJson(
              res,
              400,
              {
                error:
                  '選択できないアイコンです'
              }
            );
          }

          next.icon =
            body.icon;
        }

        next.updatedAt =
          Date.now();

        fs.writeFileSync(
          ADMIN_FILE,
          JSON.stringify(
            next,
            null,
            2
          )
        );

        return sendJson(
          res,
          200,
          {
            ok: true,
            username:
              next.username,
            color:
              next.color,
            icon:
              next.icon
          }
        );
      }

      /*
       * 旧APIとの互換用。
       *
       * 現在のパスワードを確認して
       * 新しいパスワードへ変更。
       *
       * 新しいパスワードには
       * 長さ制限を設けない。
       */
      if (
        url.pathname ===
          '/api/admin/password' &&
        req.method ===
          'POST'
      ) {
        if (
          !requireAdmin(
            req,
            res
          )
        ) {
          return;
        }

        const {
          current,
          next
        } =
          await readBody(
            req
          );

        if (
          !verifyAdminPassword(
            String(
              current || ''
            )
          )
        ) {
          return sendJson(
            res,
            401,
            {
              error:
                '現在のパスワードが違います'
            }
          );
        }

        if (
          typeof next !==
          'string'
        ) {
          return sendJson(
            res,
            400,
            {
              error:
                '新しいパスワードを入力してください'
            }
          );
        }

        setAdminPassword(
          next
        );

        return sendJson(
          res,
          200,
          {
            ok: true
          }
        );
      }

      /* ===================== ユーザー管理 ===================== */

      if (
        url.pathname ===
          '/api/users' ||
        url.pathname.startsWith(
          '/api/users/'
        )
      ) {
        const parts =
          url.pathname
            .split('/')
            .filter(Boolean);

        if (
          !requireAdmin(
            req,
            res
          )
        ) {
          return;
        }

        if (
          req.method ===
            'GET' &&
          !parts[2]
        ) {
          return sendJson(
            res,
            200,
            loadUsers().map(
              (u) => ({
                id: u.id,
                username:
                  u.username,
                createdAt:
                  u.createdAt,
                updatedAt:
                  u.updatedAt
              })
            )
          );
        }

        if (
          req.method ===
            'POST' &&
          !parts[2]
        ) {
          const body =
            await readBody(
              req
            );

          const username =
            String(
              body.username ||
                ''
            ).trim();

          const password =
            String(
              body.password ||
                ''
            );

          if (
            !/^[A-Za-z0-9_@.-]{3,40}$/.test(
              username
            )
          ) {
            return sendJson(
              res,
              400,
              {
                error:
                  'ユーザー名は3〜40文字の英数字・_・@・.-で設定してください'
              }
            );
          }

          if (
            password.length <
            8
          ) {
            return sendJson(
              res,
              400,
              {
                error:
                  'パスワードは8文字以上にしてください'
              }
            );
          }

          const users =
            loadUsers();

          if (
            users.some(
              (u) =>
                u.username.toLowerCase() ===
                username.toLowerCase()
            )
          ) {
            return sendJson(
              res,
              409,
              {
                error:
                  'そのユーザー名はすでに登録されています'
              }
            );
          }

          const user = {
            id:
              crypto
                .randomBytes(
                  16
                )
                .toString(
                  'hex'
                ),
            username,
            ...makeHash(
              password
            ),
            createdAt:
              Date.now(),
            updatedAt:
              Date.now()
          };

          const firstUser =
            users.length ===
            0;

          users.push(
            user
          );

          saveUsers(
            users
          );

          if (
            firstUser
          ) {
            let cards =
              load();

            const legacy =
              {};

            cards.forEach(
              (c) => {
                if (
                  c.owned ||
                  c.qr
                ) {
                  legacy[
                    c.id
                  ] = {
                    owned:
                      !!c.owned,
                    qr:
                      String(
                        c.qr ||
                          ''
                      )
                  };
                }
              }
            );

            if (
              Object.keys(
                legacy
              ).length
            ) {
              const data =
                loadUserData();

              data[user.id] =
                legacy;

              saveUserData(
                data
              );
            }

            if (
              cards.some(
                (c) =>
                  c.owned ||
                  c.qr
              )
            ) {
              cards =
                cards.map(
                  (c) => {
                    const cp =
                      {
                        ...c
                      };

                    delete cp.owned;
                    delete cp.qr;

                    return cp;
                  }
                );

              save(
                cards
              );
            }
          }

          return sendJson(
            res,
            201,
            {
              id:
                user.id,
              username:
                user.username,
              createdAt:
                user.createdAt
            }
          );
        }

        if (
          req.method ===
            'PUT' &&
          parts[2]
        ) {
          const users =
            loadUsers();

          const i =
            users.findIndex(
              (u) =>
                u.id ===
                parts[2]
            );

          if (
            i < 0
          ) {
            return sendJson(
              res,
              404,
              {
                error:
                  'ユーザーが見つかりません'
              }
            );
          }

          const body =
            await readBody(
              req
            );

          if (
            body.username !==
            undefined
          ) {
            const username =
              String(
                body.username
              ).trim();

            if (
              !/^[A-Za-z0-9_@.-]{3,40}$/.test(
                username
              )
            ) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'ユーザー名は3〜40文字の英数字・_・@・.-で設定してください'
                }
              );
            }

            if (
              users.some(
                (u, j) =>
                  j !== i &&
                  u.username.toLowerCase() ===
                    username.toLowerCase()
              )
            ) {
              return sendJson(
                res,
                409,
                {
                  error:
                    'そのユーザー名はすでに登録されています'
                }
              );
            }

            users[i].username =
              username;
          }

          if (
            body.password !==
            undefined
          ) {
            const password =
              String(
                body.password
              );

            if (
              password.length <
              8
            ) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'パスワードは8文字以上にしてください'
                }
              );
            }

            Object.assign(
              users[i],
              makeHash(
                password
              )
            );
          }

          users[i].updatedAt =
            Date.now();

          saveUsers(
            users
          );

          return sendJson(
            res,
            200,
            {
              id:
                users[i].id,
              username:
                users[i].username,
              updatedAt:
                users[i].updatedAt
            }
          );
        }

        if (
          req.method ===
            'DELETE' &&
          parts[2]
        ) {
          const users =
            loadUsers();

          if (
            !users.some(
              (u) =>
                u.id ===
                parts[2]
            )
          ) {
            return sendJson(
              res,
              404,
              {
                error:
                  'ユーザーが見つかりません'
              }
            );
          }

          saveUsers(
            users.filter(
              (u) =>
                u.id !==
                parts[2]
            )
          );

          const data =
            loadUserData();

          delete data[
            parts[2]
          ];

          saveUserData(
            data
          );

          for (
            const [
              sid,
              s
            ] of sessions
          ) {
            if (
              s.role ===
                'user' &&
              s.userId ===
                parts[2]
            ) {
              sessions.delete(
                sid
              );
            }
          }

          return sendJson(
            res,
            200,
            {
              ok: true
            }
          );
        }

        return sendJson(
          res,
          404,
          {
            error:
              'not found'
          }
        );
      }

      /* ===================== カードAPI ===================== */

      if (
        url.pathname.startsWith(
          '/api/'
        )
      ) {
        const parts =
          url.pathname
            .split('/')
            .filter(Boolean);

        let cards =
          load();

        /*
         * カード一覧。
         */
        if (
          parts[1] ===
            'cards' &&
          req.method ===
            'GET' &&
          !parts[2]
        ) {
          if (
            isAdminReq(req)
          ) {
            return sendJson(
              res,
              200,
              cards.map(
                withSeries
              )
            );
          }

          const uid =
            requireUser(
              req,
              res
            );

          if (!uid) {
            return;
          }

          return sendJson(
            res,
            200,
            publicCardsForUser(
              cards,
              uid
            )
          );
        }

        /*
         * 一般ユーザー本人の
         * 所持・QR更新。
         */
        if (
          parts[1] ===
            'cards' &&
          parts[2] &&
          parts[3] ===
            'public' &&
          req.method ===
            'PATCH'
        ) {
          const uid =
            requireUser(
              req,
              res
            );

          if (!uid) {
            return;
          }

          if (
            !cards.some(
              (c) =>
                c.id ===
                parts[2]
            )
          ) {
            return sendJson(
              res,
              404,
              {
                error:
                  'not found'
              }
            );
          }

          const body =
            await readBody(
              req
            );

          const data =
            loadUserData();

          data[uid] =
            data[uid] ||
            {};

          data[uid][
            parts[2]
          ] =
            data[uid][
              parts[2]
            ] || {};

          if (
            typeof body.qr ===
            'string'
          ) {
            data[uid][
              parts[2]
            ].qr =
              body.qr.slice(
                0,
                200
              );
          }

          if (
            typeof body.owned ===
            'boolean'
          ) {
            data[uid][
              parts[2]
            ].owned =
              body.owned;
          }

          if (
            typeof body.favorite ===
            'boolean'
          ) {
            data[uid][
              parts[2]
            ].favorite =
              body.favorite;
          }

          saveUserData(
            data
          );

          const updated =
            publicCardsForUser(
              cards,
              uid
            ).find(
              (c) =>
                c.id ===
                parts[2]
            );

          return sendJson(
            res,
            200,
            updated
          );
        }

        /*
         * ここから下は管理者のみ。
         */
        if (
          !requireAdmin(
            req,
            res
          )
        ) {
          return;
        }

        /* ---------- 新規カード ---------- */

        if (
          parts[1] ===
            'cards' &&
          req.method ===
            'POST' &&
          !parts[2]
        ) {
          const c =
            clean(
              stripPublicOnlyFields(
                await readBody(
                  req
                )
              ),
              Date.now()
            );

          cards.push(c);

          save(
            cards
          );

          return sendJson(
            res,
            201,
            withSeries(c)
          );
        }

        /* ---------- カード編集 ---------- */

        if (
          parts[1] ===
            'cards' &&
          parts[2] &&
          req.method ===
            'PUT'
        ) {
          const i =
            cards.findIndex(
              (c) =>
                c.id ===
                parts[2]
            );

          if (
            i < 0
          ) {
            return sendJson(
              res,
              404,
              {
                error:
                  'not found'
              }
            );
          }

          const old =
            cards[i];

          const body =
            stripPublicOnlyFields(
              await readBody(
                req
              )
            );

          cards[i] =
            clean(
              {
                ...old,
                ...body,
                id:
                  old.id
              },
              old.id
            );

          save(
            cards
          );

          return sendJson(
            res,
            200,
            withSeries(
              cards[i]
            )
          );
        }

        /* ---------- カード削除 ---------- */

        if (
          parts[1] ===
            'cards' &&
          parts[2] &&
          req.method ===
            'DELETE'
        ) {
          const deletedId =
            parts[2];

          save(
            cards.filter(
              (c) =>
                c.id !==
                deletedId
            )
          );

          const userData =
            loadUserData();

          let changed =
            false;

          for (
            const userId of Object.keys(
              userData
            )
          ) {
            if (
              userData[
                userId
              ] &&
              userData[
                userId
              ][deletedId]
            ) {
              delete userData[
                userId
              ][deletedId];

              changed =
                true;
            }
          }

          if (changed) {
            saveUserData(
              userData
            );
          }

          return sendJson(
            res,
            200,
            {
              ok: true
            }
          );
        }

        /* ---------- 全カード削除 ---------- */

        if (
          parts[1] ===
            'cards' &&
          !parts[2] &&
          req.method ===
            'DELETE'
        ) {
          const count =
            cards.length;

          save([]);

          saveUserData(
            {}
          );

          console.log(
            `[delete-all] ${count}枚のカードをすべて削除しました`
          );

          return sendJson(
            res,
            200,
            {
              ok: true,
              removed:
                count
            }
          );
        }

        /* ===================== JSON復元 ===================== */

        if (
          parts[1] ===
            'restore' &&
          req.method ===
            'POST'
        ) {
          const arr =
            await readBody(
              req
            );

          if (
            !Array.isArray(
              arr
            )
          ) {
            return sendJson(
              res,
              400,
              {
                error:
                  '配列のJSONが必要です'
              }
            );
          }

          cards =
            arr.map(
              (c, i) =>
                clean(
                  c,
                  c.id ||
                    Date.now() +
                      '-' +
                      i
                )
            );

          const result =
            tidyAndMigrate(
              cards
            );

          cards =
            result.cards;

          save(
            cards
          );

          return sendJson(
            res,
            200,
            cards.map(
              withSeries
            )
          );
        }

        /* ===================== カード整理 ===================== */

        if (
          parts[1] ===
            'tidy' &&
          req.method ===
            'POST'
        ) {
          const result =
            tidyAndMigrate(
              cards
            );

          cards =
            result.cards;

          save(
            cards
          );

          return sendJson(
            res,
            200,
            {
              cards:
                cards.map(
                  withSeries
                ),
              removed:
                result.removed
            }
          );
        }

        /* ===================== HTMLインポート ===================== */

        if (
          parts[1] ===
            'import' &&
          req.method ===
            'POST'
        ) {
          const body =
            await readBody(
              req
            );

          if (
            !body.html
          ) {
            return sendJson(
              res,
              400,
              {
                error:
                  'HTMLを貼り付けてください'
              }
            );
          }

          let base =
            DEFAULT_BASE;

          try {
            if (
              body.base
            ) {
              base =
                new URL(
                  body.base
                ).href;
            }
          } catch {}

          const found =
            parseCards(
              String(
                body.html
              ),
              base
            );

          if (
            !found.length
          ) {
            return sendJson(
              res,
              422,
              {
                error:
                  'カードを検出できませんでした。ターミナルの [import] ログを確認してください'
              }
            );
          }

          const result =
            mergeCards(
              cards,
              found
            );

          const tidyResult =
            tidyAndMigrate(
              cards
            );

          cards =
            tidyResult.cards;

          save(
            cards
          );

          console.log(
            `[import] ${result.added}枚追加 / ${result.updated}枚補完・更新 / ${tidyResult.removed}枚を整理`
          );

          return sendJson(
            res,
            200,
            {
              added:
                result.added,
              updated:
                result.updated,
              removed:
                tidyResult.removed,
              cards:
                cards.map(
                  withSeries
                )
            }
          );
        }

        return sendJson(
          res,
          404,
          {
            error:
              'not found'
          }
        );
      }

      /* ===================== 静的ファイル ===================== */

      /*
       * /
       *   → index.html
       *
       * /admin
       *   → admin.html
       */
      let reqPath =
        url.pathname === '/'
          ? 'index.html'
          : url.pathname ===
              '/admin'
            ? 'admin.html'
            : decodeURIComponent(
                url.pathname
              ).replace(
                /^\/+/,
                ''
              );

      const file =
        path.join(
          PUB,
          reqPath
        );

      const publicRoot =
        path.resolve(
          PUB
        );

      const resolved =
        path.resolve(
          file
        );

      /*
       * publicフォルダ外への
       * パストラバーサルを防止。
       */
      if (
        resolved !==
          publicRoot &&
        !resolved.startsWith(
          publicRoot +
            path.sep
        )
      ) {
        res.writeHead(
          403
        );

        return res.end(
          'Forbidden'
        );
      }

      if (
        !fs.existsSync(
          resolved
        ) ||
        fs.statSync(
          resolved
        ).isDirectory()
      ) {
        res.writeHead(
          404
        );

        return res.end(
          'Not found'
        );
      }

      res.writeHead(
        200,
        {
          'Content-Type':
            mime[
              path.extname(
                resolved
              ).toLowerCase()
            ] ||
            'application/octet-stream'
        }
      );

      fs.createReadStream(
        resolved
      ).pipe(res);

    } catch (e) {
      console.error(
        '[error]',
        req.method,
        req.url,
        e.message
      );

      if (
        res.headersSent
      ) {
        return res.end();
      }

      sendJson(
        res,
        e.status || 500,
        {
          error:
            e.message ||
            'サーバー内部エラー'
        }
      );
    }
  }
).listen(
  PORT,
  () =>
    console.log(
      `✨ アイカツ！バインダー起動: http://localhost:${PORT}（管理サイトは /admin ）`
    )
);