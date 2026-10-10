import math
def resp(t,d,b):
    w0=2*math.pi/d; z=1-b
    if abs(z-1)<1e-9: return 1-math.exp(-w0*t)*(1+w0*t)
    wd=w0*math.sqrt(1-z*z)
    return 1-math.exp(-z*w0*t)*(math.cos(wd*t)+(z*w0/wd)*math.sin(wd*t))
def settle(d,b,eps=0.001):
    T=0; t=0; dt=0.0005
    last=0
    while t<5:
        if abs(1-resp(t,d,b))>eps: last=t
        t+=dt
    return last
for name,d,b in [('smooth',0.5,0.0),('snappy',0.5,0.15),('bouncy',0.5,0.3),('glass-ish',0.35,0.2)]:
    T=settle(d,b)
    T=math.ceil(T*100)/100
    n=40
    pts=[resp(T*i/n,d,b) for i in range(n+1)]
    pts[-1]=1.0
    mx=max(pts)
    print(f"{name}: duration={d} bounce={b} zeta={1-b:.2f} stiffness={(2*math.pi/d)**2:.1f} damping={4*math.pi*(1-b)/d:.2f} settle(0.1%)={T}s overshoot={(mx-1)*100:.1f}%")
    print("  linear(" + ", ".join(f"{p:.3f}".rstrip('0').rstrip('.') if p not in (0,1) else str(int(p)) for p in pts) + f")  /* {int(T*1000)}ms */")
