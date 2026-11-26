{% if grains.get('kernel') == 'Linux' and grains.get('os_family') == 'Debian' %}
itms-baseline-packages-upgraded:
  pkg.uptodate:
    - refresh: true
    - dist_upgrade: false

{% else %}
itms-baseline-unsupported-platform:
  test.fail_without_changes:
    - name: patch.baseline supports Debian and Ubuntu Linux only.
{% endif %}