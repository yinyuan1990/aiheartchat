import { useNavigate } from 'react-router-dom';

/** token 失效后的重新进入页 */
export function EnterPage() {
  const nav = useNavigate();
  return (
    <div className="app">
      <div className="page" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div className="page-title" style={{ textAlign: 'center', fontSize: 30 }}>心之音</div>
        <p className="hint">登录状态已失效</p>
        <button className="btn mt16" onClick={() => nav('/', { replace: true })}>重新进入</button>
        <p className="hint" style={{ marginTop: 10 }}>
          本平台仅限年满 18 周岁用户使用，继续使用即代表同意
          <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => nav('/agreement/user')}>《用户协议》</span>
          与
          <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => nav('/agreement/privacy')}>《隐私政策》</span>
        </p>
      </div>
    </div>
  );
}
