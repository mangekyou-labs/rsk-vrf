# Independent spec-derived reference: RFC 9380 expand_message_xmd (H=Keccak-256, legacy padding),
# hash_to_field (L=48, m=1, count=2), generic SVDW (6.6.1, Z per Appendix H.1), BN254 G1 (y^2=x^3+3, cofactor 1).
import sys
p=21888242871839275222246405745257275088696311157297823662689037894645226208583
A,B=0,3
M64=(1<<64)-1
RC=[0x0000000000000001,0x0000000000008082,0x800000000000808A,0x8000000080008000,0x000000000000808B,0x0000000080000001,0x8000000080008081,0x8000000000008009,0x000000000000008A,0x0000000000000088,0x0000000080008009,0x000000008000000A,0x000000008000808B,0x800000000000008B,0x8000000000008089,0x8000000000008003,0x8000000000008002,0x8000000000000080,0x000000000000800A,0x800000008000000A,0x8000000080008081,0x8000000000008080,0x0000000080000001,0x8000000080008008]
ROT=[[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]]
def rol(x,n):
    n%=64
    return ((x<<n)|(x>>(64-n)))&M64 if n else x
def f(s):
    for rc in RC:
        C=[s[x][0]^s[x][1]^s[x][2]^s[x][3]^s[x][4] for x in range(5)]
        D=[C[(x-1)%5]^rol(C[(x+1)%5],1) for x in range(5)]
        s=[[s[x][y]^D[x] for y in range(5)] for x in range(5)]
        Bm=[[0]*5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                Bm[y][(2*x+3*y)%5]=rol(s[x][y],ROT[x][y])
        s=[[Bm[x][y]^((~Bm[(x+1)%5][y])&Bm[(x+2)%5][y]) for y in range(5)] for x in range(5)]
        s[0][0]^=rc
    return s
def keccak256(m:bytes)->bytes:
    rate=136; m=bytearray(m); m.append(0x01)
    while len(m)%rate: m.append(0)
    m[-1]|=0x80
    s=[[0]*5 for _ in range(5)]
    for off in range(0,len(m),rate):
        blk=m[off:off+rate]
        for i in range(rate//8):
            s[i%5][i//5]^=int.from_bytes(blk[8*i:8*i+8],'little')
        s=f(s)
    out=b''
    for i in range(4): out+=s[i%5][i//5].to_bytes(8,'little')
    return out
assert keccak256(b'').hex()=='c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
def xmd(msg,dst,n):
    b_in=32; ell=-(-n//b_in); dp=dst+bytes([len(dst)])
    z=bytes(136)
    b0=keccak256(z+msg+n.to_bytes(2,'big')+b'\x00'+dp)
    bs=[keccak256(b0+b'\x01'+dp)]
    for i in range(2,ell+1):
        bs.append(keccak256(bytes(a^b for a,b in zip(b0,bs[-1]))+bytes([i])+dp))
    return b''.join(bs)[:n]
def h2f(msg,dst,count=2):
    L=48; u=xmd(msg,dst,count*L)
    return [int.from_bytes(u[i*L:(i+1)*L],'big')%p for i in range(count)]
inv0=lambda x: pow(x,p-2,p)
def is_sq(x): return pow(x,(p-1)//2,p) in (0,1)
def sqrt(x):
    assert p%4==3
    r=pow(x,(p+1)//4,p); assert r*r%p==x
    return r
sgn0=lambda x:x%2
g=lambda x:(x**3+A*x+B)%p
def find_z():
    # RFC 9380 App. H.1 find_z_svdw
    ctr=1
    while True:
        for Z in (ctr,p-ctr):
            gz=g(Z)
            if gz==0: continue
            h=(-(3*Z*Z+4*A)*inv0(4*gz))%p
            if h==0 or not is_sq(h): continue
            if is_sq(gz) or is_sq(g((-Z*inv0(2))%p)): return Z
        ctr+=1
Z=find_z()
c1=g(Z); c2=(-Z*inv0(2))%p
c3=sqrt((-c1*(3*Z*Z+4*A))%p)
if sgn0(c3)==1: c3=p-c3
c4=(-4*c1*inv0(3*Z*Z+4*A))%p
def svdw(u):
    tv1=u*u%p*c1%p; tv2=(1+tv1)%p; tv1=(1-tv1)%p; tv3=inv0(tv1*tv2%p)
    tv4=u*tv1%p*tv3%p*c3%p
    x1=(c2-tv4)%p; x2=(c2+tv4)%p
    x3=((tv2*tv2%p*tv3%p)**2%p*c4+Z)%p
    for x in (x1,x2,x3):
        if is_sq(g(x)): break
    y=sqrt(g(x))
    if sgn0(u)!=sgn0(y): y=p-y
    return x,y
def add(P,Q):
    if P is None: return Q
    if Q is None: return P
    (x1,y1),(x2,y2)=P,Q
    if x1==x2:
        if (y1+y2)%p==0: return None
        l=3*x1*x1*inv0(2*y1)%p
    else: l=(y2-y1)*inv0(x2-x1)%p
    x3=(l*l-x1-x2)%p
    return x3,(l*(x1-x3)-y1)%p
def hash_to_g1(msg,dst):
    u0,u1=h2f(msg,dst)
    return add(svdw(u0),svdw(u1)),(u0,u1)
if __name__=="__main__":
    print("Z",Z,"c1",hex(c1),"c2",hex(c2),"c3",hex(c3),"c4",hex(c4))
    dst=b"BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_"
    for r in (1,2,1000,10000000):
        msg=keccak256(r.to_bytes(8,'big'))
        P,u=hash_to_g1(msg,dst)
        print("round",r,"msg",msg.hex(),"u0",u[0],"u1",u[1],"x",P[0],"y",P[1])
