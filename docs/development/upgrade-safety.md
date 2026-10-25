# Coordinator upgrade checks

Run the same gates as CI from the repository root:

```sh
python3 contracts/script/test-upgrade-safety.py --integration
python3 contracts/script/check-upgrade-safety.py
```

The gate compiles the coordinator and checks its deployed runtime against the 24,576-byte limit. A margin below 1,024 bytes emits a GitHub Actions warning. Creation bytecode is not used for this check.

The committed snapshot is `contracts/storage-layout/VRFCoordinator.json`. ERC-7201 structs do not appear in the coordinator's ordinary Solidity storage layout. The extractor instead discovers namespaced structs in its inheritance tree and compiles a temporary contract containing those structs. Solidity supplies member slots, offsets, widths, and nested mapping/array layouts. The snapshot also records enum variants and the actual namespace locations used by storage accessors, including inherited OpenZeppelin storage. The slot-based ReentrancyGuard uint256 is included explicitly, resolving its most-derived slot getter. Unsupported accessor expressions fail the gate for explicit review.

Existing namespaces and fields must retain their locations, order, types and enum variant order. Appending fields to a namespace or a mapping value is allowed; changing the element size of an array is rejected. New namespaces are allowed, provided their actual accessor locations and occupied root storage ranges do not overlap another namespace. Ranges that exceed the uint256 slot address space are rejected. Ordinary, non-namespaced coordinator storage is rejected. These checks protect layout compatibility; upgrade authorization and retained request behavior are tested separately through the proxy.

After an intentional compatible addition, regenerate and review the snapshot:

```sh
python3 contracts/script/check-upgrade-safety.py --write-snapshot
```

Regeneration first checks compatibility with the existing snapshot. CI also compares the compiled layout with the base revision's snapshot, so committing an incompatible regenerated snapshot cannot bypass the gate. The initial adoption PR bootstraps this check because its base predates the snapshot. Subsequent PRs remain checked against the existing base snapshot, including when a PR deletes or replaces its own snapshot.

The integration gate tests compile source mutations that change the coordinator's namespace location, inherited guard slot, mapped Request packing, and drand array element packing. Each must fail against the committed snapshot. They also reject snapshot regeneration when a new namespace starts at an existing namespace's root or its next occupied slot, or its range exceeds uint256. They restore the source and snapshot after each run.

When upgrading a pre-admin tracer or fees coordinator proxy, the owner must initialize the appended parameters atomically:

```solidity
coordinator.upgradeToAndCall(
    newImplementation,
    abi.encodeCall(VRFCoordinator.initializeAdminParameters, ())
);
```

This migration preserves the existing round offset, ownership, keys, drand configs, nonces, request records and payee balances. It initializes the callback gas cap to `200000`. For the pre-admin tracer it also initializes fee `2e13`, timeout `1200` blocks and confirmations `12`; the fees coordinator retains its existing fee, timeout and confirmations. The initial snapshot preserves the fees coordinator layout already merged on main, appending the callback gas cap after its payee balance mapping. Upgrade regressions cover both predecessor implementations. Existing requests retain their frozen values. The migration can run once and rejects newly initialized proxies; later upgrades must use their own migration data, or empty data when no migration is needed.
