// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// TEST-ONLY stand-in for the Rootstock RSKIP516 precompiles so forge (revm) can check
/// correctness. Gas figures under this mock are meaningless; Rootstock figures come from RPC.
/// isMul = true: input (x, y, k) -> k*(x,y); false: input (x1, y1, x2, y2) -> sum. (0,0) = infinity.
contract Secp256k1PrecompileMock {
    uint256 constant P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    bool immutable isMul;

    constructor(bool _isMul) {
        isMul = _isMul;
    }

    function _inv(uint256 a) internal pure returns (uint256 r) {
        // Fermat inversion by square-and-multiply (pure, slow, test-only)
        uint256 e = P - 2;
        r = 1;
        while (e > 0) {
            if (e & 1 == 1) r = mulmod(r, a, P);
            a = mulmod(a, a, P);
            e >>= 1;
        }
    }

    function _check(uint256 x, uint256 y) internal pure {
        if (x == 0 && y == 0) return;
        require(x < P && y < P && mulmod(y, y, P) == addmod(mulmod(x, mulmod(x, x, P), P), 7, P), "invalid point");
    }

    function _add(uint256 ax, uint256 ay, uint256 bx, uint256 by) internal pure returns (uint256, uint256) {
        if (ax == 0 && ay == 0) return (bx, by);
        if (bx == 0 && by == 0) return (ax, ay);
        uint256 l;
        if (ax == bx) {
            if (addmod(ay, by, P) == 0) return (0, 0);
            l = mulmod(mulmod(3, mulmod(ax, ax, P), P), _inv(mulmod(2, ay, P)), P);
        } else {
            l = mulmod(addmod(by, P - ay, P), _inv(addmod(bx, P - ax, P)), P);
        }
        uint256 x = addmod(mulmod(l, l, P), P - addmod(ax, bx, P), P);
        return (x, addmod(mulmod(l, addmod(ax, P - x, P), P), P - ay, P));
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        if (isMul) {
            (uint256 x, uint256 y, uint256 k) = abi.decode(data, (uint256, uint256, uint256));
            _check(x, y);
            (uint256 rx, uint256 ry) = (0, 0);
            while (k > 0) {
                if (k & 1 == 1) (rx, ry) = _add(rx, ry, x, y);
                (x, y) = _add(x, y, x, y);
                k >>= 1;
            }
            return abi.encode(rx, ry);
        }
        (uint256 ax, uint256 ay, uint256 bx, uint256 by) = abi.decode(data, (uint256, uint256, uint256, uint256));
        _check(ax, ay);
        _check(bx, by);
        (uint256 sx, uint256 sy) = _add(ax, ay, bx, by);
        return abi.encode(sx, sy);
    }
}
