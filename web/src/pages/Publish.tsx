import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, uploadFile } from '../api';
import { CityPickerSheet } from '../components/CityPicker';
import { locateCity } from '../cities';

/** 发布动态：媒体区 + 描述卡片 + 设置行 */
export function PublishPage() {
  const nav = useNavigate();
  const [mode, setMode] = useState<'photo' | 'video'>('photo');
  const [content, setContent] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [videoUrl, setVideoUrl] = useState('');
  const [cityName, setCityName] = useState('');
  const [showCity, setShowCity] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const imgRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    locateCity().then((city) => {
      if (city) setCityName((prev) => prev || city);
    });
  }, []);

  const addImages = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, 9 - images.length)) {
        const url = await uploadFile('image', file);
        setImages((prev) => [...prev, url]);
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      setUploading(false);
    }
  };

  const addVideo = async (files: FileList | null) => {
    if (!files?.[0]) return;
    setUploading(true);
    try {
      setVideoUrl(await uploadFile('video', files[0]));
    } catch (e: any) {
      alert(e.message);
    } finally {
      setUploading(false);
    }
  };

  const publish = async () => {
    const isVideo = mode === 'video';
    if (isVideo && !videoUrl) return alert('请选择视频');
    if (!isVideo && images.length === 0 && !content.trim()) return alert('写点什么或选择图片');
    setBusy(true);
    try {
      await api('/moments', {
        method: 'POST',
        body: {
          type: isVideo ? 2 : 1,
          content: content.trim(),
          images: isVideo ? [] : images,
          videoUrl: isVideo ? videoUrl : undefined,
          cityName: cityName || undefined,
        },
      });
      nav('/plaza', { replace: true });
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  const segStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    textAlign: 'center',
    padding: '8px 0',
    borderRadius: 9,
    fontSize: 13,
    cursor: 'pointer',
    background: active ? 'var(--bg)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--text-2)',
    fontWeight: active ? 600 : 400,
    transition: 'all 0.15s',
  });

  return (
    <div className="app">
      {/* 顶栏 */}
      <div className="row" style={{ padding: '14px 16px' }}>
        <span style={{ fontSize: 20, color: 'var(--text-2)', cursor: 'pointer', width: 40 }} onClick={() => nav(-1)}>×</span>
        <span className="grow" style={{ textAlign: 'center', fontSize: 16, fontWeight: 600 }}>发布动态</span>
        <span style={{ width: 40, textAlign: 'right' }} className="small">{uploading ? '上传中' : ''}</span>
      </div>

      <div className="page no-scrollbar" style={{ padding: '0 16px' }}>
        {/* 类型分段控件 */}
        <div style={{ display: 'flex', background: 'var(--bg-input)', borderRadius: 11, padding: 3, marginBottom: 14 }}>
          <span style={segStyle(mode === 'photo')} onClick={() => setMode('photo')}>图文</span>
          <span style={segStyle(mode === 'video')} onClick={() => setMode('video')}>视频</span>
        </div>

        {/* 媒体区 */}
        {mode === 'photo' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            {images.map((url, i) => (
              <div key={i} style={{ position: 'relative' }}>
                <img src={url} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 10, display: 'block' }} alt="" />
                <span
                  onClick={() => setImages(images.filter((_, idx) => idx !== i))}
                  style={{
                    position: 'absolute', top: 4, right: 4, width: 20, height: 20,
                    background: 'rgba(0,0,0,0.65)', borderRadius: 10, color: '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, cursor: 'pointer',
                  }}
                >×</span>
              </div>
            ))}
            {images.length < 9 && (
              <div
                onClick={() => imgRef.current?.click()}
                style={{
                  aspectRatio: '1', borderRadius: 10, background: 'var(--bg-card)',
                  border: '1px dashed #333', cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
                }}
              >
                <span style={{ fontSize: 24, color: 'var(--text-3)', lineHeight: 1 }}>+</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{images.length === 0 ? '添加图片' : `${images.length}/9`}</span>
              </div>
            )}
          </div>
        ) : videoUrl ? (
          <div style={{ position: 'relative' }}>
            <video src={videoUrl} autoPlay loop muted playsInline style={{ width: '100%', maxHeight: '40vh', objectFit: 'contain', borderRadius: 12, background: '#111', display: 'block' }} />
            <span
              className="small"
              style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.65)', padding: '4px 12px', borderRadius: 12, cursor: 'pointer', color: '#fff' }}
              onClick={() => videoRef.current?.click()}
            >重选</span>
          </div>
        ) : (
          <div
            onClick={() => videoRef.current?.click()}
            style={{
              aspectRatio: '16/9', borderRadius: 12, background: 'var(--bg-card)',
              border: '1px dashed #333', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
          >
            <span style={{ fontSize: 26, color: 'var(--text-3)', lineHeight: 1 }}>+</span>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>添加视频，竖屏效果最佳</span>
          </div>
        )}

        {/* 描述卡片 */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 12, padding: '12px 14px', marginTop: 14 }}>
          <textarea
            value={content}
            maxLength={1000}
            placeholder="添加作品描述，让更多人认识你…"
            onChange={(e) => setContent(e.target.value)}
            style={{
              width: '100%', minHeight: 88, background: 'transparent', border: 'none',
              outline: 'none', color: 'var(--text)', fontSize: 15, lineHeight: 1.6, resize: 'none', padding: 0,
            }}
          />
          <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-3)' }}>{content.length}/1000</div>
        </div>

        {/* 设置行 */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 12, marginTop: 10, marginBottom: 16 }}>
          <div
            className="row"
            style={{ padding: '14px 14px', cursor: 'pointer', borderBottom: '1px solid var(--line)' }}
            onClick={() => setShowCity(true)}
          >
            <span style={{ fontSize: 14 }} className="grow">所在位置</span>
            <span style={{ fontSize: 14, color: cityName ? 'var(--text)' : 'var(--text-3)' }}>{cityName || '选择'}</span>
            <span style={{ color: 'var(--text-3)' }}>›</span>
          </div>
          <div className="row" style={{ padding: '14px 14px' }}>
            <span style={{ fontSize: 14 }} className="grow">谁可以看</span>
            <span style={{ fontSize: 13, color: 'var(--text-3)' }}>仅异性可见</span>
          </div>
        </div>
      </div>

      {/* 底部发布 */}
      <div style={{ padding: '10px 16px calc(12px + env(safe-area-inset-bottom))' }}>
        <button className="btn" disabled={busy || uploading} onClick={publish}>{busy ? '发布中…' : '发布'}</button>
      </div>

      <input ref={imgRef} type="file" accept="image/*" multiple hidden onChange={(e) => addImages(e.target.files)} />
      <input ref={videoRef} type="file" accept="video/*" hidden onChange={(e) => addVideo(e.target.files)} />
      {showCity && (
        <CityPickerSheet
          current={cityName}
          onClose={() => setShowCity(false)}
          onSelect={(city) => { setCityName(city); setShowCity(false); }}
        />
      )}
    </div>
  );
}
