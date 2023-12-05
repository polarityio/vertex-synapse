module.exports = {
  name: 'Vertex',
  polarityIntegrationUuid: '4eb6d8a0-8efd-11ee-8ad3-4d9eee77d25a',
  acronym: 'VTX',
  description: 'Search Vertex Synapse',
  request: {
    // Provide the path to your certFile. Leave an empty string to ignore this option.
    cert: '',
    // Provide the path to your private key. Leave an empty string to ignore this option.
    key: '',
    // Provide the key passphrase if required.  Leave an empty string to ignore this option.
    passphrase: '',
    // Provide the Certificate Authority. Leave an empty string to ignore this option.
    ca: '',
    // An HTTP proxy to be used. Supports proxy Auth with Basic Auth, identical to support for
    // the url parameter (by embedding the auth info in the uri)
    proxy: ''
  },
  logging: { level: 'info' },
  entityTypes: ['IPv4', 'IPv6', 'domain', 'email', 'MD5', 'SHA1', 'SHA256', 'cve'],
  onDemandOnly: true,
  defaultColor: 'light-blue',
  styles: ['./styles/styles.less'],
  block: {
    component: {
      file: './components/component.js'
    },
    template: {
      file: './templates/template.hbs'
    }
  },
  options: [
    {
      key: 'url',
      name: 'Vertex URL',
      description: 'The URL of the Vertex API',
      default: '',
      type: 'text',
      userCanEdit: false,
      adminOnly: true
    },
    {
      key: 'username',
      name: 'Vertex Username',
      description: 'Your Vertex Username',
      default: '',
      type: 'text',
      userCanEdit: false,
      adminOnly: true
    },
    {
      key: 'password',
      name: 'Vertex Password',
      description: 'Your Vertex Password',
      default: '',
      type: 'password',
      userCanEdit: false,
      adminOnly: true
    }
  ]
};
