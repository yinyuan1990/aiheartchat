import { useEffect, useRef, useState } from 'react';
import { CITY_LETTERS, locateCity } from '../cities';

const HOT_CITIES = ['北京', '上海', '广州', '深圳', '成都', '杭州', '重庆', '武汉', '西安', '南京', '长沙', '三亚'];

/**
 * 城市选择组件：定位 + 热门 + 字母分组列表 + 右侧 A-Z 索引导航（无滚动条）。
 * 用法：<CityField value={city} onChange={setCity} />
 */
export function CityField({ value, onChange, placeholder = '选择城市' }: {
  value: string;
  onChange: (city: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div
        className="input row"
        style={{ cursor: 'pointer', justifyContent: 'space-between' }}
        onClick={() => setOpen(true)}
      >
        <span style={{ color: value ? 'var(--text)' : 'var(--text-3)' }}>{value || placeholder}</span>
        <span className="muted">›</span>
      </div>
      {open && (
        <CityPickerSheet
          current={value}
          onClose={() => setOpen(false)}
          onSelect={(city) => {
            onChange(city);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

export function CityPickerSheet({ current, onClose, onSelect }: {
  current?: string;
  onClose: () => void;
  onSelect: (city: string) => void;
}) {
  const [located, setLocated] = useState<string | null>(null);
  const [locating, setLocating] = useState(true);
  const [activeLetter, setActiveLetter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    locateCity().then((city) => {
      setLocated(city);
      setLocating(false);
    });
  }, []);

  const jumpTo = (letter: string) => {
    setActiveLetter(letter);
    if (letter === '#') {
      scrollRef.current?.scrollTo({ top: 0 });
    } else {
      sectionRefs.current[letter]?.scrollIntoView({ block: 'start' });
    }
  };

  return (
    <div className="mask bottom" onClick={onClose}>
      <div
        className="sheet"
        style={{ padding: 0, height: '78vh', display: 'flex', flexDirection: 'column', position: 'relative' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ padding: '16px 16px 10px' }}>
          <span className="grow" style={{ fontSize: 17, fontWeight: 700 }}>选择城市</span>
          <span className="muted" style={{ cursor: 'pointer', fontSize: 14 }} onClick={onClose}>关闭</span>
        </div>

        {/* 内容区（无滚动条） */}
        <div ref={scrollRef} className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', padding: '0 40px 24px 16px' }}>
          {/* 定位 + 热门 */}
          <div className="muted" style={{ margin: '4px 0 8px', fontSize: 12 }}>定位 / 热门</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            <div
              onClick={() => located && onSelect(located)}
              style={{
                padding: '9px 0', textAlign: 'center', borderRadius: 10, fontSize: 13, cursor: 'pointer',
                background: 'rgba(254,44,85,0.12)', color: 'var(--accent)',
              }}
            >
              {locating ? '定位中…' : located ?? '定位不可用'}
            </div>
            {HOT_CITIES.map((c) => (
              <div
                key={c}
                onClick={() => onSelect(c)}
                style={{
                  padding: '9px 0', textAlign: 'center', borderRadius: 10, fontSize: 13, cursor: 'pointer',
                  background: 'var(--bg-input)',
                  color: c === current ? 'var(--accent)' : 'var(--text)',
                }}
              >
                {c}
              </div>
            ))}
          </div>

          {/* 字母分组 */}
          {CITY_LETTERS.map(([letter, cities]) => (
            <div key={letter} ref={(el) => { sectionRefs.current[letter] = el; }}>
              <div className="muted" style={{ padding: '16px 0 6px', fontSize: 13, fontWeight: 600 }}>{letter}</div>
              {cities.map((city) => (
                <div
                  key={city}
                  onClick={() => onSelect(city)}
                  style={{
                    padding: '12px 4px', fontSize: 15, cursor: 'pointer',
                    borderBottom: '1px solid var(--line)',
                    color: city === current ? 'var(--accent)' : 'var(--text)',
                  }}
                >
                  {city}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* 右侧字母索引 */}
        <div
          style={{
            position: 'absolute', right: 4, top: 90, bottom: 20, width: 26,
            display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1, zIndex: 2,
          }}
        >
          {['#', ...CITY_LETTERS.map(([l]) => l)].map((l) => (
            <div
              key={l}
              onClick={() => jumpTo(l)}
              style={{
                textAlign: 'center', fontSize: 10, lineHeight: '15px', cursor: 'pointer',
                color: activeLetter === l ? '#fff' : 'var(--text-2)',
                background: activeLetter === l ? 'var(--accent)' : 'transparent',
                borderRadius: 8, width: 16, alignSelf: 'center',
              }}
            >
              {l}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
