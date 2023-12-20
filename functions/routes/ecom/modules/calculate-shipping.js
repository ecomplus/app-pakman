const axios = require('axios')
const ecomUtils = require('@ecomplus/utils')

exports.post = ({ appSdk }, req, res) => {
  /**
   * Treat `params` and (optionally) `application` from request body to properly mount the `response`.
   * JSON Schema reference for Calculate Shipping module objects:
   * `params`: https://apx-mods.e-com.plus/api/v1/calculate_shipping/schema.json?store_id=100
   * `response`: https://apx-mods.e-com.plus/api/v1/calculate_shipping/response_schema.json?store_id=100
   *
   * Examples in published apps:
   * https://github.com/ecomplus/app-mandabem/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   * https://github.com/ecomplus/app-datafrete/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   * https://github.com/ecomplus/app-jadlog/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   */

  const { params, application } = req.body
  const { storeId } = req
  // setup basic required response object
  const response = {
    shipping_services: []
  }
  // merge all app options configured by merchant
  const appData = Object.assign({}, application.data, application.hidden_data)

  if (appData.free_shipping_from_value >= 0) {
    response.free_shipping_from_value = appData.free_shipping_from_value
  }
  if (!params.to) {
    // just a free shipping preview with no shipping address received
    // respond only with free shipping option
    res.send(response)
    return
  }

  // get token
  const { apikey } = appData
  if (!apikey) {
    // must have configured a3 tecnologia token token
    return res.status(409).send({
      error: 'CALCULATE_AUTH_ERR',
      message: 'Apikey unset on app hidden data (merchant must configure the app)'
    })
  }

  const destinationZip = params.to ? params.to.zip.replace(/\D/g, '') : ''
  const originZip = params.from
    ? params.from.zip.replace(/\D/g, '')
    : appData.zip ? appData.zip.replace(/\D/g, '') : '00000000'

  const checkZipCode = rule => {
    // validate rule zip range
    if (destinationZip && rule.zip_range) {
      const { min, max } = rule.zip_range
      return Boolean((!min || destinationZip >= min) && (!max || destinationZip <= max))
    }
    return true
  }

  // search for configured free shipping rule
  if (Array.isArray(appData.free_shipping_rules)) {
    for (let i = 0; i < appData.free_shipping_rules.length; i++) {
      const rule = appData.free_shipping_rules[i]
      if (rule && checkZipCode(rule) && (rule.min_amount || (rule.product_ids && rule.product_ids.length))) {
        let hasProduct
        if (Array.isArray(rule.product_ids) && rule.product_ids.length) {
          const isAllProducts = rule.all_product_ids
          hasProduct = isAllProducts
            ? params.items.every(item => rule.product_ids.indexOf(item.product_id) > -1)
            : params.items.some(item => rule.product_ids.indexOf(item.product_id) > -1)
        }
        if (!rule.min_amount && (!rule.product_ids || hasProduct)) {
          response.free_shipping_from_value = 0
          break
        } else if (!(response.free_shipping_from_value <= rule.min_amount) && (!rule.product_ids || hasProduct)) {
          response.free_shipping_from_value = rule.min_amount
        }
      }
    }
  }

  /* DO THE STUFF HERE TO FILL RESPONSE OBJECT WITH SHIPPING SERVICES */


  if (params.items) {
    let cartSubtotal = 0
    const itens = []
    params.items.forEach((item) => {
      const { sku, quantity, dimensions, weight } = item
      cartSubtotal += (quantity * ecomUtils.price(item))
      // parse cart items to pakman schema
      let gWeight = 0
      if (weight && weight.value) {
        switch (weight.unit) {
          case 'kg':
            gWeight = weight.value * 1000
            break
          case 'mg':
            gWeight = weight.value / 1000
            break
          default:
            gWeight = weight.value
        }
      }
      const cmDimensions = {}
      if (dimensions) {
        for (const side in dimensions) {
          const dimension = dimensions[side]
          if (dimension && dimension.value) {
            switch (dimension.unit) {
              case 'm':
                cmDimensions[side] = dimension.value * 100
                break
              case 'mm':
                cmDimensions[side] = dimension.value / 10
                break
              default:
                cmDimensions[side] = dimension.value
            }
          }
        }
      }
      for (let index = 0; index < quantity; index++) {
        itens.push({
          productValue: ecomUtils.price(item) * 100,
          dimension: {
            height: cmDimensions.height || 1,
            width: cmDimensions.width || 1,
            length: cmDimensions.length || 1,
            weight: gWeight
          }  
        }) 
      }
    })
    const body = {
      address: {
        zipCode: destinationZip
      },
      itens
    }
    console.log('sending body', JSON.stringify(body))
    return axios.post(
      `https://api-public.pakman.com.br/pak/v1/ePak/quotations`,
      body,
      {
        headers: {
          'x-api-key': apikey,
          'Content-type': 'application/json'
        }
      },
      {
        timeout: (params.is_checkout_confirmation ? 8000 : 6000)
      }
    )
      .then(result => {
        const { data, status } = result
        if (data && status === 200) {
          // success response
          // parse to E-Com Plus shipping line object
          const { cost, serviceLevelAgreement } = data
          const shippingLine = {
            from: {
              ...params.from,
              zip: originZip
            },
            to: params.to,
            price: cost,
            total_price: cost,
            discount: 0,
            delivery_time: {
              days: parseInt(serviceLevelAgreement, 10),
              working_days: true
            },
            posting_deadline: {
              days: 3,
              ...appData.posting_deadline
            },
            flags: ['pakman-ws', 'pakman-transportadora']
          }

          // check for default configured additional/discount price
          if (appData.additional_price) {
            if (appData.additional_price > 0) {
              shippingLine.other_additionals = [{
                tag: 'additional_price',
                label: 'Adicional padrão',
                price: appData.additional_price
              }]
            } else {
              // negative additional price to apply discount
              shippingLine.discount -= appData.additional_price
            }
            // update total price
            shippingLine.total_price += appData.additional_price
          }

          // change label
          const label = appData.label || 'Transportadora'

          // push shipping service object to response
          response.shipping_services.push({
            label,
            carrier: 'pakman transportadora',
            service_name: 'pakman_name',
            service_code: 'pakman',
            shipping_line: shippingLine
          })

          res.send(response)
        } else {
          // console.log(data)
          const err = new Error('Invalid pakman calculate response')
          err.response = { data, status }
          throw err
        }
      })

      .catch(err => {
        let { message, response } = err
        if (response && response.data) {
          // try to handle Frete Barato error response
          const { data } = response
          let result
          if (typeof data === 'string') {
            try {
              result = JSON.parse(data)
            } catch (e) {
            }
          } else {
            result = data
          }
          console.log('> Pakman invalid result:', data)
          if (result && result.data) {
            // Pakman error message
            return res.status(409).send({
              error: 'CALCULATE_FAILED',
              message: result.data
            })
          }
          message = `${message} (${response.status})`
        } else {
          console.error(err)
        }
        return res.status(409).send({
          error: 'CALCULATE_ERR',
          message
        })
      })
  } else {
    res.status(400).send({
      error: 'CALCULATE_EMPTY_CART',
      message: 'Cannot calculate shipping without cart items'
    })
  }



  res.send(response)
}
