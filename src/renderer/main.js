import Vue from 'vue'

import App from './App'
import store from './store'

import 'font-awesome/css/font-awesome.min.css'

Vue.config.productionTip = false

/* eslint-disable no-new */
new Vue({
  components: { App },
  store,
  template: '<App/>'
}).$mount('#app')
