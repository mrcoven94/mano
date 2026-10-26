/* Device frames drawn in CSS and SVG: an iPhone and a browser window. No screenshots, so the content stays live text. */

function StatusBar() {
  return (
    <div className="ios-status" aria-hidden="true">
      <span className="ios-time">9:41</span>
      <span className="ios-icons">
        <svg width="17" height="11" viewBox="0 0 17 11"><rect x="0" y="7" width="3" height="4" rx="1" /><rect x="4.5" y="5" width="3" height="6" rx="1" /><rect x="9" y="2.5" width="3" height="8.5" rx="1" /><rect x="13.5" y="0" width="3" height="11" rx="1" /></svg>
        <svg width="15" height="11" viewBox="0 0 15 11"><path d="M7.5 2.2c2.2 0 4.2.9 5.7 2.3l1.1-1.1A9.6 9.6 0 0 0 7.5.6 9.6 9.6 0 0 0 .7 3.4l1.1 1.1a8 8 0 0 1 5.7-2.3Zm0 3.2c1.3 0 2.5.5 3.4 1.3l1.1-1.1a6.4 6.4 0 0 0-9 0l1.1 1.1c.9-.8 2.1-1.3 3.4-1.3Zm0 3.2c.5 0 .9.2 1.2.5L7.5 10.3 6.3 9.1c.3-.3.7-.5 1.2-.5Z" /></svg>
        <svg width="26" height="12" viewBox="0 0 26 12"><rect x=".5" y=".5" width="22" height="11" rx="3.5" fill="none" stroke="currentColor" opacity=".4" /><rect x="2" y="2" width="17" height="8" rx="2" /><path d="M24 4v4c.8-.3 1.3-1.1 1.3-2S24.8 4.3 24 4Z" opacity=".5" /></svg>
      </span>
    </div>
  );
}

export function IPhone({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`iphone ${className}`}>
      <div className="iphone-screen">
        <span className="island" aria-hidden="true" />
        <StatusBar />
        {children}
        <span className="home-bar" aria-hidden="true" />
      </div>
    </div>
  );
}

export function Browser({ url = "withmano.com", children, className = "" }: { url?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`browser ${className}`}>
      <div className="browser-bar" aria-hidden="true">
        <span className="lights"><i /><i /><i /></span>
        <span className="url"><svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor"><rect x="1" y="5" width="8" height="6.5" rx="1.5" /><path d="M2.8 5V3.6a2.2 2.2 0 0 1 4.4 0V5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>{url}</span>
        <span />
      </div>
      <div className="browser-body">{children}</div>
    </div>
  );
}
