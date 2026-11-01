# Stable Android update signing

Published 1.0.6, 1.1.0 and 1.1.1 APKs were signed with different ephemeral GitHub runner debug keys. Their private keys were not persisted. Updates across these certificates cannot be installed in place.

All future release builds use the explicitly configured retained local key, with its public SHA-256 fingerprint pinned in `.github/signing-certificate.sha256`. This retains compatibility with APKs previously built locally with that key. It cannot recover compatibility with the old GitHub runner certificates.

Local builds read `android/signing.properties` (ignored), or `KRMZI_KEYSTORE_PATH`, `KRMZI_STORE_PASSWORD`, `KRMZI_KEY_ALIAS`, `KRMZI_KEY_PASSWORD`. Keep the private `.signing/` directory backed up privately. Never commit or attach the keystore to a release.

GitHub builds require repository secrets `KRMZI_KEYSTORE_BASE64`, `KRMZI_STORE_PASSWORD`, `KRMZI_KEY_ALIAS`, `KRMZI_KEY_PASSWORD`. Provisioning the private key requires the owner's explicit approval. No private key has been uploaded as part of this change yet.

The workflow builds only `assembleRelease`, verifies the certificate before uploading, and stages the exact release APK. A missing key or mismatched certificate fails the release instead of falling back to a debug build.

Automatic tag-triggered publishing is disabled until private-key provisioning is explicitly approved. Locally signed APKs may be uploaded manually; GitHub Actions cannot overwrite them with a fresh debug signature. Manual CI dispatch still fails closed unless its signing secrets are configured.
