
talosconfig:
    #!/usr/bin/env bash
    echo "Generating Talos configuration..."
    export dir=$(mktemp -d)
    pushd $dir > /dev/null
    op read "op://Private/Homelab/secrets.yaml" > secrets.yaml
    talosctl gen config --with-secrets secrets.yaml --output-types talosconfig -o talosconfig homelab https://192.168.100.10 -e 192.168.100.10
    rm -f secrets.yaml
    rm -rf ~/.talos/config
    talosctl config merge talosconfig
    rm -rf talosconfig
    popd > /dev/null
    rm -rf $dir
    echo "Talos configuration generated successfully."

kubeconfig:
    #!/usr/bin/env bash
    echo "Generating kubeconfig..."
    talosctl kubeconfig --force -e 192.168.100.10 -n 192.168.100.10
    echo "Kubeconfig generated successfully."